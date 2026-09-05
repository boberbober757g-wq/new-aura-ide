/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — провайдер языковых моделей для встроенного чата.
 * Каждый здоровый ключ (ok, без высокого пинга) появляется в списке моделей
 * чата как BYOK-модель; запросы уходят на его OpenAI-совместимый эндпоинт.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	ILanguageModelChatProvider, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatResponse,
	ILanguageModelChatRequestOptions, ILanguageModelChatInfoOptions, ILanguageModelChatMetadata,
	IChatResponsePart, IChatMessage,
} from '../../chat/common/languageModels.js';
import { IAuraApiKeysService, IAuraApiKey } from '../common/auraApiKeys.js';
import {
	AuraSseParser, estimateCostUsd, estimateTokens, parseToolArguments, spentUsdSince,
	toOpenAIMessages, toOpenAITools, toOpenAIToolChoice, type IAuraUsageRecord,
} from '../common/auraApiChatProtocol.js';

export const AURA_API_VENDOR = 'auraApi';
export const AURA_API_SYSTEM_PROMPT_SETTING = 'auraApi.chat.systemPrompt';
export const AURA_API_DAILY_BUDGET_SETTING = 'auraApi.chat.dailyBudgetUsd';

const USAGE_STORAGE_KEY = 'auraApi.usage.records';
const USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const USAGE_MAX_RECORDS = 2000;

export class AuraApiChatProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private usageRecords: IAuraUsageRecord[] = [];

	constructor(
		private readonly keysService: IAuraApiKeysService,
		private readonly configurationService: IConfigurationService,
		private readonly storageService: IStorageService,
	) {
		this.keysService.onDidChange(() => this._onDidChange.fire());
		this.loadUsage();
	}

	/** Здоровые ключи как модели чата. */
	private usableKeys(): IAuraApiKey[] {
		return this.keysService.getKeys().filter(k => {
			const s = this.keysService.getStatus(k.id);
			return s.ok === true && !s.excludedHighPing;
		});
	}

	/* --------------------------------- учёт расхода -------------------------------- */

	private loadUsage(): void {
		try {
			const raw = this.storageService.get(USAGE_STORAGE_KEY, StorageScope.APPLICATION, '[]');
			const parsed = JSON.parse(raw) as IAuraUsageRecord[];
			const cutoff = Date.now() - USAGE_RETENTION_MS;
			this.usageRecords = Array.isArray(parsed) ? parsed.filter(r => r?.at > cutoff) : [];
		} catch {
			this.usageRecords = [];
		}
	}

	private recordUsage(record: IAuraUsageRecord): void {
		this.usageRecords.push(record);
		if (this.usageRecords.length > USAGE_MAX_RECORDS) {
			this.usageRecords = this.usageRecords.slice(-USAGE_MAX_RECORDS);
		}
		this.storageService.store(USAGE_STORAGE_KEY, JSON.stringify(this.usageRecords), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** Расход по ключу за сутки — используется и лимитом, и колонкой расхода в менеджере. */
	spentTodayUsd(keyId: string): number {
		return spentUsdSince(this.usageRecords, keyId, Date.now());
	}

	private budgetExceeded(keyId: string): boolean {
		const budget = this.configurationService.getValue<number>(AURA_API_DAILY_BUDGET_SETTING) ?? 0;
		return budget > 0 && this.spentTodayUsd(keyId) >= budget;
	}

	/* --------------------------------- метаданные ---------------------------------- */

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const keys = this.usableKeys();
		return keys.map((key, index) => {
			const identifier = `${AURA_API_VENDOR}/${key.id}`;
			const capabilities = this.keysService.getModelCapabilities?.(key.id) ?? {};
			const metadata: ILanguageModelChatMetadata = {
				extension: new ExtensionIdentifier('aura.aura-api'),
				name: `${key.name} (${key.model})`,
				id: key.id,
				vendor: AURA_API_VENDOR,
				version: '1.0.0',
				family: key.model,
				maxInputTokens: capabilities.contextWindow ?? 128000,
				maxOutputTokens: capabilities.maxOutputTokens ?? 16000,
				// Первый здоровый ключ становится моделью по умолчанию: без Copilot-аккаунта
				// иначе в чате не выбрана ни одна модель и отправка молча ничего не делает.
				isDefaultForLocation: index === 0 ? { panel: true, editor: true, terminal: true, notebook: true } : {},
				isUserSelectable: true,
				isBYOK: true,
				tooltip: `Aura API: ${key.model} @ ${key.baseUrl}`,
				capabilities: {
					toolCalling: capabilities.supportsTools !== false,
					agentMode: capabilities.supportsTools !== false,
					vision: capabilities.supportsVision === true,
				},
			};
			return { identifier, metadata };
		});
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		// modelId приходит как `<vendor>/<id>`; поддерживаем и голый id.
		const requestedId = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
		const routed = this.keysService.resolveKeyForModel ? this.keysService.resolveKeyForModel() : undefined;
		const preferred = this.keysService.getKeys().find(k => k.id === requestedId) ?? routed;
		if (!preferred) { throw new Error(`Aura API: нет живых ключей (modelId=${modelId})`); }
		const candidates: IAuraApiKey[] = [preferred, ...this.usableKeys().filter(k => k.id !== preferred.id)]
			.filter(k => !this.budgetExceeded(k.id));
		if (candidates.length === 0) {
			throw new Error('Aura API: дневной бюджет исчерпан по всем ключам (auraApi.chat.dailyBudgetUsd)');
		}

		const systemPrompt = await this.resolveSystemPrompt();
		const oaiMessages = toOpenAIMessages(messages as unknown as ReadonlyArray<{ role: number; content: readonly { type?: string; value?: unknown; name?: string; toolCallId?: string; parameters?: unknown }[] }>, systemPrompt);
		const tools = toOpenAITools(options.tools as readonly unknown[] | undefined);
		const toolChoice = toOpenAIToolChoice(options.toolMode as number | undefined, !!tools);

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		// Генератор ниже — не метод класса, ему нужен явный доступ к сервисам провайдера.
		const self = this;
		let resolveResult!: (v: string) => void;
		let rejectResult!: (e: unknown) => void;
		const result = new Promise<string>((res, rej) => { resolveResult = res; rejectResult = rej; });
		// Потребители читают stream и часто не ждут result: без no-op обработчика
		// его отклонение всплывает как unhandled rejection.
		result.catch(() => { });

		const stream = (async function* (): AsyncIterable<IChatResponsePart> {
			let lastError: unknown;
			let yielded = false; // стрим начался — фейловер на другой ключ уже невозможен (иначе дубли текста)
			for (const key of candidates) {
				if (controller.signal.aborted) { break; }
				let fullText = '';
				try {
					const secret = await self.keysService.getSecret(key.id);
					const base = key.baseUrl.replace(/\/+$/, '');
					const response = await fetch(`${base}/chat/completions`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
						},
						body: JSON.stringify({
							model: key.model,
							messages: oaiMessages,
							stream: true,
							stream_options: { include_usage: true },
							...(tools ? { tools, tool_choice: toolChoice } : {}),
							...(options.modelOptions ?? {}),
						}),
						signal: controller.signal,
					});
					if (!response.ok || !response.body) {
						const body = await response.text().catch(() => '');
						throw new Error(`Aura API [${key.name}]: HTTP ${response.status} — ${body.slice(0, 200)}`);
					}

					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					const parser = new AuraSseParser();
					let promptTokens = 0;
					let completionTokens = 0;

					for (; ;) {
						const { done, value } = await reader.read();
						const events = done
							? parser.flush()
							: parser.push(decoder.decode(value, { stream: true }));
						for (const event of events) {
							switch (event.kind) {
								case 'text':
									fullText += event.value;
									yielded = true;
									yield { type: 'text', value: event.value };
									break;
								case 'tool_call':
									yielded = true;
									yield {
										type: 'tool_use',
										name: event.call.name,
										toolCallId: event.call.toolCallId || `aura-${key.id}-${event.call.name}`,
										parameters: parseToolArguments(event.call.argumentsText),
									};
									break;
								case 'usage':
									promptTokens = event.usage.promptTokens;
									completionTokens = event.usage.completionTokens;
									break;
								case 'done':
									break;
							}
						}
						if (done) { break; }
					}

					if (promptTokens === 0 && completionTokens === 0) {
						// Провайдер не прислал usage — считаем локальной оценкой, чтобы бюджет не был слепым.
						promptTokens = estimateTokens(oaiMessages.map(m => m.content ?? '').join('\n'));
						completionTokens = estimateTokens(fullText);
					}
					self.recordUsage({
						keyId: key.id,
						model: key.model,
						promptTokens,
						completionTokens,
						costUsd: estimateCostUsd(key.model, promptTokens, completionTokens),
						at: Date.now(),
					});

					resolveResult(fullText);
					return;
				} catch (e) {
					if (yielded) {
						// Обрыв после начала генерации: молча переключать ключ нельзя — получится
						// склейка двух разных ответов. Отдаём маркер и сохраняем уже полученный текст.
						const message = e instanceof Error ? e.message : String(e);
						yield { type: 'text', value: `\n\n⚠️ Aura API: поток прерван (${message}). Ответ сохранён; повторите запрос — он уйдёт на другой ключ.` };
						resolveResult(fullText);
						return;
					}
					lastError = e; // ошибка до первого байта — пробуем следующий ключ
				}
			}
			const err = lastError instanceof Error ? lastError : new Error('Aura API: все ключи недоступны');
			rejectResult(err);
			throw err;
		})();

		return { stream, result };
	}

	/** Системный промпт: настройка + `.aura/rules.md` воркспейса, если он подхвачен сервисом ключей. */
	private async resolveSystemPrompt(): Promise<string> {
		const configured = (this.configurationService.getValue<string>(AURA_API_SYSTEM_PROMPT_SETTING) ?? '').trim();
		const workspaceRules = (await this.keysService.getWorkspaceRules?.()) ?? '';
		return [configured, workspaceRules.trim()].filter(Boolean).join('\n\n');
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.map(p => typeof (p as { value?: unknown }).value === 'string' ? (p as { value: string }).value : '').join(' ');
		return estimateTokens(text);
	}
}
