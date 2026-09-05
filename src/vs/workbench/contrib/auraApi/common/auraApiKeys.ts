/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — менеджер API-ключей: хранение, проверка пинга/ошибок,
 * эвристика подлинности модели и безопасности ответов.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Limiter } from '../../../../base/common/async.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { joinPath } from '../../../../base/common/resources.js';
import {
	parseKeysBulk, detectProvider, defaultBaseUrl, secretFingerprint,
	classifyHttpStatus, cooldownMsForStatus, modelAuthenticityPercent,
	type AuraProvider, type IAuraApiGroup, type AuraHealthStatus,
} from './auraApiModel.js';

export const IAuraApiKeysService = createDecorator<IAuraApiKeysService>('auraApiKeysService');

export type AuraApiKeyPriority = 'high' | 'medium' | 'low';

export interface IAuraApiKey {
	readonly id: string;
	name: string;
	baseUrl: string;
	model: string;
	expectedModel?: string;
	group?: string;
	priority: AuraApiKeyPriority;
	createdAt: number;
	/** Этап 2: провайдер (solo-режим) или 'litellm' (team-режим через гейтвей) */
	provider?: AuraProvider;
	/** Этап 2: вес для взвешенного round-robin внутри группы */
	weight?: number;
	/** Этап 2: fingerprint секрета для дедупликации повторной вставки (сам секрет не хранится) */
	secretFingerprint?: string;
	/** Этап A2: фактические возможности модели, установленные probe'ом */
	capabilities?: IAuraModelCapabilities;
	/** Этап A2: дополнительные модели этого ключа, доступные в пикере чата */
	chatModels?: string[];
}

export interface IAuraApiKeyStatus {
	checking: boolean;
	/** Этап 2: классифицированный статус из ядра (ok/unauthorized/forbidden/ratelimited/notfound/down/unknown) */
	health?: AuraHealthStatus;
	/** Этап 2: до какого момента ключ в cooldown (ms epoch, Infinity = до ручной перепроверки) */
	cooldownUntil?: number;
	lastChecked?: number;
	pingMs?: number;
	ok?: boolean;
	error?: string;
	authenticityPct?: number | null;
	securityPct?: number | null;
	securityNotes?: string[];
	excludedHighPing?: boolean;
	/** Число подряд неуспешных проверок — задаёт экспоненту перепроверки. */
	failureStreak?: number;
}

export interface IAuraApiKeysService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	getKeys(): IAuraApiKey[];
	getSecretKeyRef(id: string): string;
	addKey(input: Omit<IAuraApiKey, 'id' | 'createdAt'>, secret: string): Promise<IAuraApiKey>;
	addKeysBulk(text: string): Promise<{ added: number; skipped: number }>;
	removeKey(id: string): Promise<void>;
	updateKey(id: string, patch: Partial<IAuraApiKey>): Promise<void>;
	getSecret(id: string): Promise<string | undefined>;
	getStatus(id: string): IAuraApiKeyStatus;
	checkKey(id: string): Promise<IAuraApiKeyStatus>;
	checkAll(): Promise<void>;
	bestKey(): IAuraApiKey | undefined;
	selectForChat(id: string): Promise<void>;
	/** Умная загрузка: один baseUrl + список ключей (по одному на строку), общие модель/группа/приоритет. */
	smartImport(baseUrl: string, model: string, keysText: string, group?: string, priority?: AuraApiKeyPriority): Promise<{ added: number; skipped: number }>;
	/** Дискавери моделей по провайдеру (уровень 1 — «врёт», доступ реально проверяет probeModel). */
	discoverModels(baseUrl: string, secret?: string, provider?: AuraProvider): Promise<string[]>;

	/* ---- Этап 2: группы, роутер, probe моделей ---- */
	/** Управление группами (приоритет 0 = высший). */
	getGroups(): IAuraApiGroup[];
	createGroup(name: string, priority?: number, baseUrl?: string): IAuraApiGroup;
	/** Массовый импорт «вставь что угодно» (сырые ключи, pipe, CSV, .env, JSON) с дедупликацией. */
	bulkImport(text: string, groupName?: string): Promise<{ added: number; skipped: number; errors: string[] }>;
	/** Реальная проверка доступа модели: POST chat/completions max_tokens:1, сравнение declared vs returned model. */
	probeModel(keyId: string, modelId?: string): Promise<{ available: 'yes' | 'no' | 'unknown'; authenticityPct: number | null; error?: string }>;
	/** Проверить все ключи через очередь с ограничением параллелизма и backoff на 429. */
	checkAllQueued(maxParallel?: number): Promise<void>;
	/** Роутер: выбрать живой ключ для модели (приоритет групп → взвешенный RR → cooldown). */
	resolveKeyForModel(modelId?: string): IAuraApiKey | undefined;
	/** Маска секрета для UI (sk-…ABCD). Сам секрет из хранилища не читается. */
	maskedSecretLabel(id: string): string;

	/* ---- Этап A2: возможности модели, правила воркспейса, экспорт конфигурации ---- */
	/** Фактические возможности модели ключа, определённые при probe (для метаданных чата). */
	getModelCapabilities(id: string): IAuraModelCapabilities;
	/** Модели ключа, доступные в пикере чата (основная + добавленные пользователем). */
	getChatModels(id: string): string[];
	/** Заменить список моделей ключа для чата. */
	setChatModels(id: string, models: string[]): Promise<void>;
	/** Содержимое `.aura/rules.md` из корня проекта (пусто, если файла нет). */
	getWorkspaceRules(): Promise<string>;
	/** Экспорт конфигурации ключей БЕЗ секретов — для передачи настройки коллеге. */
	exportConfiguration(): string;
	/** Импорт конфигурации без секретов: ключи создаются как «ожидают секрет». */
	importConfiguration(json: string): Promise<{ groups: number; keys: number }>;
}

export interface IAuraModelCapabilities {
	contextWindow?: number;
	maxOutputTokens?: number;
	supportsTools?: boolean;
	supportsVision?: boolean;
}

/** Справочник популярных моделей для подсказок при добавлении ключей. */
export const POPULAR_MODELS: readonly string[] = [
	'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini',
	'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
	'gemini-2.5-pro', 'gemini-2.5-flash',
	'deepseek-chat', 'deepseek-reasoner',
	'llama-3.3-70b', 'qwen-2.5-72b', 'mistral-large',
];

const STORAGE_KEYS = 'auraApi.keys';
const STORAGE_SELECTED = 'auraApi.chat.selectedKeyId';
const SECRET_PREFIX = 'auraApi.key.';
const HIGH_PING_MS = 3000;
const STORAGE_GROUPS = 'auraApi.groups';
const STORAGE_FINGERPRINT_SALT = 'auraApi.fingerprintSalt';
const RATE_LIMIT_BACKOFF_MS = 5_000;
const QUEUE_PARALLEL = 5;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const HEALTHY_RECHECK_MS = 15 * 60 * 1000;
const COOLDOWN_RECHECK_BASE_MS = 60 * 1000;
const AURA_RULES_PATH = '.aura/rules.md';

/** Эвристика «вредоносности» ответа модели: ищем подозрительные паттерны команд. */
const MALICIOUS_PATTERNS: Array<{ re: RegExp; note: string }> = [
	{ re: /rm\s+-rf\s+\/|del\s+\/[sfq]/i, note: 'деструктивная команда удаления' },
	{ re: /powershell[^\n]*-enc\b|powershell[^\n]*-encodedcommand/i, note: 'скрытый PowerShell payload' },
	{ re: /curl[^\n|]*\|\s*(ba)?sh|wget[^\n|]*\|\s*(ba)?sh/i, note: 'скачивание и исполнение скрипта из сети' },
	{ re: /\bIEX\b|Invoke-Expression/i, note: 'динамическое исполнение кода' },
	{ re: /reg\s+add[^\n]*Run/i, note: 'прописывание в автозагрузку' },
];

export class AuraApiKeysService extends Disposable implements IAuraApiKeysService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private keys: IAuraApiKey[] = [];
	private groups: IAuraApiGroup[] = [];
	private readonly statuses = new Map<string, IAuraApiKeyStatus>();
	private readonly checkLimiter = new Limiter<unknown>(QUEUE_PARALLEL);
	private checkCts: CancellationTokenSource | undefined;
	private fingerprintSalt = '';
	private readonly discoveryCache = new Map<string, { at: number; models: string[] }>();
	private healthTimer: Timeout | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this.load();
		this.scheduleHealthChecks();
		this._register(toDisposable(() => {
			this.checkCts?.cancel();
			this.checkCts?.dispose();
			if (this.healthTimer !== undefined) {
				clearTimeout(this.healthTimer);
				this.healthTimer = undefined;
			}
		}));
	}

	/**
	 * Адаптивный health-checker: здоровые ключи перепроверяются раз в 15 минут,
	 * ключи в cooldown — по экспоненте от базовой минуты. Таймер снимается в dispose,
	 * иначе закрытое окно продолжает бить по эндпоинтам провайдеров.
	 */
	private scheduleHealthChecks(): void {
		const tick = () => {
			const now = Date.now();
			for (const key of this.keys) {
				const status = this.getStatus(key.id);
				if (status.checking) {
					continue;
				}
				const since = now - (status.lastChecked ?? 0);
				const inCooldown = status.cooldownUntil !== undefined && status.cooldownUntil > now;
				if (inCooldown) {
					continue; // ключ уже помечен: перепроверять раньше окончания cooldown бессмысленно
				}
				const failures = status.health && status.health !== 'ok' ? Math.min(6, (status.failureStreak ?? 1)) : 0;
				const interval = failures > 0
					? COOLDOWN_RECHECK_BASE_MS * Math.pow(2, failures - 1)
					: HEALTHY_RECHECK_MS;
				if (since >= interval) {
					void this.checkLimiter.queue(() => this.checkKey(key.id));
				}
			}
			this.healthTimer = setTimeout(tick, 60_000);
		};
		this.healthTimer = setTimeout(tick, 60_000);
	}

	/** Локальная соль для отпечатков секретов (создаётся один раз на установку). */
	private getFingerprintSalt(): string {
		if (!this.fingerprintSalt) {
			let salt = this.storageService.get(STORAGE_FINGERPRINT_SALT, StorageScope.APPLICATION, '');
			if (!salt) {
				salt = generateUuid();
				this.storageService.store(STORAGE_FINGERPRINT_SALT, salt, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
			this.fingerprintSalt = salt;
		}
		return this.fingerprintSalt;
	}

	private fingerprint(secret: string): string {
		return secretFingerprint(secret, this.getFingerprintSalt());
	}

	private load(): void {
		try {
			const raw = this.storageService.get(STORAGE_KEYS, StorageScope.APPLICATION, '[]');
			this.keys = JSON.parse(raw) as IAuraApiKey[];
		} catch {
			this.keys = [];
		}
		try {
			const rawG = this.storageService.get(STORAGE_GROUPS, StorageScope.APPLICATION, '[]');
			this.groups = JSON.parse(rawG) as IAuraApiGroup[];
		} catch {
			this.groups = [];
		}
		if (this.groups.length === 0) {
			this.groups = [{ id: 'default', name: 'По умолчанию', priority: 0 }];
		}
	}

	private save(): void {
		this.storageService.store(STORAGE_KEYS, JSON.stringify(this.keys), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.store(STORAGE_GROUPS, JSON.stringify(this.groups), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	getKeys(): IAuraApiKey[] {
		const weight = (p: AuraApiKeyPriority) => p === 'high' ? 0 : p === 'medium' ? 1 : 2;
		return [...this.keys].sort((a, b) => weight(a.priority) - weight(b.priority) || a.name.localeCompare(b.name));
	}

	getSecretKeyRef(id: string): string {
		return SECRET_PREFIX + id;
	}

	async addKey(input: Omit<IAuraApiKey, 'id' | 'createdAt'>, secret: string): Promise<IAuraApiKey> {
		const key: IAuraApiKey = {
			...input,
			id: generateUuid(),
			createdAt: Date.now(),
			provider: input.provider ?? detectProvider(secret, input.baseUrl) ?? 'openai-compatible',
			weight: input.weight ?? 1,
			secretFingerprint: this.fingerprint(secret),
		};
		this.keys.push(key);
		await this.secretStorage.set(this.getSecretKeyRef(key.id), secret);
		this.save();
		void this.checkKey(key.id); // авто-проверка при добавлении
		return key;
	}

	async addKeysBulk(text: string): Promise<{ added: number; skipped: number }> {
		let added = 0, skipped = 0;
		// Формат JSON: [{ name, baseUrl, model, key, group?, priority? }, ...]
		const trimmed = text.trim();
		if (trimmed.startsWith('[')) {
			try {
				const arr = JSON.parse(trimmed) as Array<Record<string, string>>;
				for (const item of arr) {
					const secret = item.key ?? item.apiKey ?? item.token;
					if (item.baseUrl && item.model && secret) {
						await this.addKey({
							name: item.name ?? item.model,
							baseUrl: item.baseUrl,
							model: item.model,
							expectedModel: item.expectedModel ?? item.model,
							group: item.group,
							priority: (item.priority as AuraApiKeyPriority) ?? 'medium',
						}, secret);
						added++;
					} else { skipped++; }
				}
				return { added, skipped };
			} catch { /* не JSON — идём в построчный формат */ }
		}
		// Построчный: "название | baseUrl | модель | ключ" или просто "ключ" на строку
		for (const line of trimmed.split(/\r?\n/)) {
			const l = line.trim();
			if (!l) { continue; }
			const parts = l.split('|').map(p => p.trim());
			if (parts.length >= 4) {
				await this.addKey({ name: parts[0], baseUrl: parts[1], model: parts[2], expectedModel: parts[2], priority: 'medium' }, parts[3]);
				added++;
			} else if (parts.length === 1) {
				await this.addKey({ name: `Key ${this.keys.length + 1}`, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', priority: 'medium' }, parts[0]);
				added++;
			} else { skipped++; }
		}
		return { added, skipped };
	}

	async removeKey(id: string): Promise<void> {
		this.keys = this.keys.filter(k => k.id !== id);
		this.statuses.delete(id);
		await this.secretStorage.delete(this.getSecretKeyRef(id));
		this.save();
	}

	async updateKey(id: string, patch: Partial<IAuraApiKey>): Promise<void> {
		const key = this.keys.find(k => k.id === id);
		if (key) { Object.assign(key, patch); this.save(); }
	}

	async getSecret(id: string): Promise<string | undefined> {
		return this.secretStorage.get(this.getSecretKeyRef(id));
	}

	getStatus(id: string): IAuraApiKeyStatus {
		return this.statuses.get(id) ?? { checking: false };
	}

	private setStatus(id: string, patch: Partial<IAuraApiKeyStatus>): IAuraApiKeyStatus {
		const previous = this.getStatus(id);
		const next = { ...previous, ...patch };
		if (patch.ok !== undefined || patch.health !== undefined) {
			const healthy = next.ok === true && (next.health === undefined || next.health === 'ok');
			next.failureStreak = healthy ? 0 : (previous.failureStreak ?? 0) + 1;
		}
		this.statuses.set(id, next);
		this._onDidChange.fire();
		return next;
	}

	private async timedRequest(url: string, init: { type: 'GET' | 'POST'; data?: string; headers?: Record<string, string>; timeout?: number }): Promise<{ ms: number; status?: number; body: string }> {
		const start = Date.now();
		const ctx = await this.requestService.request({
			type: init.type,
			url,
			data: init.data,
			headers: init.headers,
			timeout: init.timeout ?? 15000,
			callSite: 'auraApi.checkKey',
		}, CancellationToken.None);
		const body = await asText(ctx) ?? '';
		return { ms: Date.now() - start, status: ctx.res.statusCode, body };
	}

	async checkKey(id: string): Promise<IAuraApiKeyStatus> {
		const key = this.keys.find(k => k.id === id);
		if (!key) { return this.getStatus(id); }
		this.setStatus(id, { checking: true, error: undefined });

		const base = key.baseUrl.replace(/\/+$/, '');
		const secret = await this.getSecret(id);
		const authHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
			...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
		};

		try {
			// 1. Пинг + доступность: GET /models
			const ping = await this.timedRequest(`${base}/models`, { type: 'GET', headers: authHeaders, timeout: 10000 });
			if (ping.status === 401 || ping.status === 403) {
				return this.setStatus(id, { checking: false, lastChecked: Date.now(), pingMs: ping.ms, ok: false, error: `HTTP ${ping.status}: ключ отклонён (недействителен или нет доступа)` });
			}
			if (ping.status === 404) {
				return this.setStatus(id, { checking: false, lastChecked: Date.now(), pingMs: ping.ms, ok: false, error: 'HTTP 404: baseUrl не похож на OpenAI-совместимый API (нет /models)' });
			}
			if (ping.status !== undefined && (ping.status < 200 || ping.status >= 300)) {
				return this.setStatus(id, {
					checking: false, lastChecked: Date.now(), pingMs: ping.ms, ok: false,
					error: `HTTP ${ping.status}`,
					health: classifyHttpStatus(ping.status),
					cooldownUntil: cooldownMsForStatus(ping.status) > 0 ? Date.now() + cooldownMsForStatus(ping.status) : undefined,
				});
			}

			const excludedHighPing = ping.ms > HIGH_PING_MS;

			// 2. Подлинность модели: спрашиваем её саму, кто она
			let authenticityPct: number | null = null;
			let securityPct: number | null = null;
			let securityNotes: string[] = [];
			try {
				const chat = await this.timedRequest(`${base}/chat/completions`, {
					type: 'POST',
					headers: authHeaders,
					timeout: 20000,
					data: JSON.stringify({
						model: key.model,
						messages: [{ role: 'user', content: 'Identify yourself: reply with ONLY your exact underlying model name and version, nothing else.' }],
						max_tokens: 50,
					}),
				});
				if (chat.status !== undefined && chat.status >= 200 && chat.status < 300) {
					let answer = '';
					let returnedModel = '';
					try {
						const parsed = JSON.parse(chat.body);
						answer = String(parsed?.choices?.[0]?.message?.content ?? '');
						returnedModel = String(parsed?.model ?? '');
					} catch { answer = chat.body; }

					// Главный сигнал — поле `model` в ответе. Самоназвание модели ненадёжно:
					// почти все модели обучены отвечать «я ChatGPT/ассистент» и не знают своего
					// точного id, поэтому оно годится только как слабое подтверждение, когда
					// упоминает ожидаемое семейство, и НИКОГДА не занижает оценку само по себе.
					const expected = (key.expectedModel ?? key.model).toLowerCase();
					const family = expected.split(/[-.\/]/).filter(w => w.length > 2);
					const answerL = answer.toLowerCase();
					const selfReportHint = answerL.includes(expected)
						? 100
						: (family.length > 0 && family.every(w => answerL.includes(w)) ? 80 : undefined);

					authenticityPct = modelAuthenticityPercent(key.model, returnedModel || undefined, selfReportHint);

					// 3. Безопасность: сканируем ответ модели на вредоносные паттерны
					securityNotes = MALICIOUS_PATTERNS.filter(p => p.re.test(chat.body)).map(p => p.note);
					const httpsPenalty = base.startsWith('http://') ? 20 : 0;
					securityPct = Math.max(0, 100 - securityNotes.length * 25 - httpsPenalty);
					if (httpsPenalty) { securityNotes.push('baseUrl без HTTPS — трафик не зашифрован'); }
				}
			} catch (e) {
				this.logService.warn('[AuraAPI] authenticity probe failed', e);
			}

			return this.setStatus(id, {
				checking: false, lastChecked: Date.now(), pingMs: ping.ms, ok: true,
				authenticityPct, securityPct, securityNotes,
				excludedHighPing,
				health: 'ok', cooldownUntil: undefined,
				error: excludedHighPing ? `Высокий пинг (${ping.ms} мс > ${HIGH_PING_MS} мс) — ключ исключён из использования` : undefined,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return this.setStatus(id, { checking: false, lastChecked: Date.now(), ok: false, error: `Сеть: ${msg}` });
		}
	}

	async checkAll(): Promise<void> {
		for (const key of this.keys) {
			await this.checkKey(key.id);
		}
	}

	bestKey(): IAuraApiKey | undefined {
		const healthy = this.keys.filter(k => {
			const s = this.getStatus(k.id);
			return s.ok === true && !s.excludedHighPing;
		});
		if (healthy.length === 0) { return undefined; }
		const weight = (p: AuraApiKeyPriority) => p === 'high' ? 0 : p === 'medium' ? 1 : 2;
		return healthy.sort((a, b) =>
			weight(a.priority) - weight(b.priority) ||
			(this.getStatus(a.id).pingMs ?? 99999) - (this.getStatus(b.id).pingMs ?? 99999)
		)[0];
	}

	async smartImport(baseUrl: string, model: string, keysText: string, group?: string, priority: AuraApiKeyPriority = 'medium'): Promise<{ added: number; skipped: number }> {
		let added = 0, skipped = 0;
		const url = baseUrl.trim().replace(/\/+$/, '');
		for (const line of keysText.split(/\r?\n/)) {
			const secret = line.trim();
			if (!secret) { continue; }
			// поддержка и "чистый ключ", и "название | ключ"
			const parts = secret.split('|').map(p => p.trim());
			const name = parts.length >= 2 ? parts[0] : undefined;
			const value = parts.length >= 2 ? parts[1] : parts[0];
			if (!value || !url || !model.trim()) { skipped++; continue; }
			await this.addKey({
				name: name ?? `${model.trim()} #${this.keys.length + 1}`,
				baseUrl: url,
				model: model.trim(),
				expectedModel: model.trim(),
				group: group?.trim() || undefined,
				priority,
			}, value);
			added++;
		}
		return { added, skipped };
	}

	async discoverModels(baseUrl: string, secret?: string, provider: AuraProvider = detectProvider(secret ?? '', baseUrl) ?? 'openai-compatible'): Promise<string[]> {
		const base = baseUrl.trim().replace(/\/+$/, '');
		// Кэш с TTL: список моделей меняется редко, а UI дёргает дискавери на каждый рендер.
		const cacheKey = `${provider}|${base}|${secret ? this.fingerprint(secret) : ''}`;
		const cached = this.discoveryCache.get(cacheKey);
		if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
			return cached.models;
		}
		let url: string;
		const headers: Record<string, string> = {};
		switch (provider) {
			case 'anthropic':
				url = `${base}/v1/models`;
				if (secret) { headers['x-api-key'] = secret; headers['anthropic-version'] = '2023-06-01'; }
				break;
			case 'google':
				url = `${base}/v1beta/models${secret ? `?key=${encodeURIComponent(secret)}` : ''}`;
				break;
			case 'openrouter':
				url = `${base}/api/v1/models`;
				if (secret) { headers['Authorization'] = `Bearer ${secret}`; }
				break;
			case 'litellm':
			case 'openai-compatible':
			default:
				url = `${base}/models`;
				if (secret) { headers['Authorization'] = `Bearer ${secret}`; }
				break;
		}
		try {
			const res = await this.timedRequest(url, { type: 'GET', headers, timeout: 10000 });
			if (res.status === undefined || res.status < 200 || res.status >= 300) { return []; }
			const parsed = JSON.parse(res.body);
			const data = parsed?.data;
			if (!Array.isArray(data)) { return []; }
			const models = data
				.map((m: { id?: string; name?: string }) => m?.id ?? (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : undefined))
				.filter((id: unknown): id is string => typeof id === 'string')
				.sort();
			this.discoveryCache.set(cacheKey, { at: Date.now(), models });
			return models;
		} catch {
			return [];
		}
	}


	/* ================== Этап 2: группы, bulkImport, probe, роутер ================== */

	getGroups(): IAuraApiGroup[] {
		return [...this.groups].sort((a, b) => a.priority - b.priority);
	}

	createGroup(name: string, priority: number = this.groups.length, baseUrl?: string): IAuraApiGroup {
		const group: IAuraApiGroup = { id: generateUuid(), name: name.trim() || 'Группа', priority, baseUrl };
		this.groups.push(group);
		this.save();
		return group;
	}

	/** Дедупликация по fingerprint секрета: повторная вставка того же ключа пропускается. */
	private hasFingerprint(fp: string): boolean {
		return this.keys.some(k => k.secretFingerprint === fp);
	}

	async bulkImport(text: string, groupName?: string): Promise<{ added: number; skipped: number; errors: string[] }> {
		const parsed = parseKeysBulk(text);
		const errors: string[] = parsed.errors.map(e => `строка ${e.line}: ${e.reason} (${e.text})`);
		let added = 0, skipped = parsed.errors.length;

		// Группа: по имени из аргумента, иначе из групп в данных, иначе дефолтная
		const resolveGroupId = (name?: string): string => {
			const target = (groupName ?? name)?.trim();
			if (!target) { return this.groups[0].id; }
			const existing = this.groups.find(g => g.name.toLowerCase() === target.toLowerCase());
			if (existing) { return existing.id; }
			return this.createGroup(target).id;
		};

		for (const draft of parsed.keys) {
			const fp = this.fingerprint(draft.key);
			if (this.hasFingerprint(fp)) { skipped++; continue; }
			const gid = resolveGroupId(draft.groupName);
			const group = this.groups.find(g => g.id === gid);
			await this.addKey({
				name: draft.label,
				baseUrl: draft.baseUrl ?? group?.baseUrl ?? defaultBaseUrl(draft.provider),
				model: POPULAR_MODELS[0],
				expectedModel: POPULAR_MODELS[0],
				group: group?.name,
				priority: 'medium',
				provider: draft.provider,
				weight: draft.weight,
			}, draft.key);
			added++;
		}
		return { added, skipped, errors };
	}

	async probeModel(keyId: string, modelId?: string): Promise<{ available: 'yes' | 'no' | 'unknown'; authenticityPct: number | null; error?: string }> {
		const key = this.keys.find(k => k.id === keyId);
		if (!key) { return { available: 'unknown', authenticityPct: null, error: 'ключ не найден' }; }
		const model = modelId ?? key.model;
		const secret = await this.getSecret(keyId);
		const base = key.baseUrl.replace(/\/+$/, '');
		try {
			const res = await this.timedRequest(`${base}/chat/completions`, {
				type: 'POST',
				headers: { 'Content-Type': 'application/json', ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}) },
				timeout: 20000,
				data: JSON.stringify({ model, messages: [{ role: 'user', content: '.' }], max_tokens: 1 }),
			});
			const status = res.status ?? 0;
			if (status === 401) {
				this.setStatus(keyId, { health: 'unauthorized', cooldownUntil: Number.POSITIVE_INFINITY, ok: false, error: 'HTTP 401: ключ отклонён' });
				return { available: 'unknown', authenticityPct: null, error: 'HTTP 401: ключ мёртв (не модель — весь ключ)' };
			}
			if (status === 403 || status === 404) {
				return { available: 'no', authenticityPct: null, error: `HTTP ${status}: нет доступа к модели` };
			}
			if (status === 429) {
				this.setStatus(keyId, { health: 'ratelimited', cooldownUntil: Date.now() + cooldownMsForStatus(429) });
				return { available: 'unknown', authenticityPct: null, error: 'HTTP 429: rate limit, ключ поставлен в cooldown' };
			}
			if (status >= 500) {
				return { available: 'unknown', authenticityPct: null, error: `HTTP ${status}: сервер недоступен` };
			}
			// 2xx: declared vs returned model — главный сигнал подлинности
			let returned: string | undefined;
			try { returned = String(JSON.parse(res.body)?.model ?? '') || undefined; } catch { /* не JSON */ }
			const pct = modelAuthenticityPercent(model, returned);
			// Проба вызова инструмента: чат помечает модель agentMode только при реальной поддержке.
			await this.probeToolCalling(key, model, secret);
			return { available: 'yes', authenticityPct: pct, error: returned && returned !== model ? `прокси вернул ${returned} вместо ${model}` : undefined };
		} catch (e) {
			return { available: 'unknown', authenticityPct: null, error: `Сеть: ${e instanceof Error ? e.message : String(e)}` };
		}
	}

	/** Минимальный запрос с одним инструментом: 400 от провайдера = tool calling не поддерживается. */
	private async probeToolCalling(key: IAuraApiKey, model: string, secret: string | undefined): Promise<void> {
		const base = key.baseUrl.replace(/\/+$/, '');
		try {
			const res = await this.timedRequest(`${base}/chat/completions`, {
				type: 'POST',
				headers: { 'Content-Type': 'application/json', ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}) },
				timeout: 20000,
				data: JSON.stringify({
					model,
					messages: [{ role: 'user', content: '.' }],
					max_tokens: 1,
					tools: [{ type: 'function', function: { name: 'aura_probe', description: 'probe', parameters: { type: 'object', properties: {} } } }],
					tool_choice: 'auto',
				}),
			});
			const supportsTools = res.status !== undefined && res.status >= 200 && res.status < 300;
			await this.updateKey(key.id, { capabilities: { ...key.capabilities, supportsTools } });
		} catch {
			// сеть моргнула — возможности не меняем, чтобы не «терять» агентный режим
		}
	}

	getModelCapabilities(id: string): IAuraModelCapabilities {
		return this.keys.find(k => k.id === id)?.capabilities ?? {};
	}

	getChatModels(id: string): string[] {
		const key = this.keys.find(k => k.id === id);
		if (!key) {
			return [];
		}
		// Основная модель всегда первая: она же используется при фейловере.
		return [key.model, ...(key.chatModels ?? []).filter(m => m && m !== key.model)];
	}

	async setChatModels(id: string, models: string[]): Promise<void> {
		const key = this.keys.find(k => k.id === id);
		if (!key) {
			return;
		}
		key.chatModels = [...new Set(models.map(m => m.trim()).filter(Boolean))];
		this.save();
	}

	async getWorkspaceRules(): Promise<string> {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return '';
		}
		try {
			const content = await this.fileService.readFile(joinPath(folder.uri, AURA_RULES_PATH));
			return content.value.toString();
		} catch {
			return ''; // файла нет — это норма
		}
	}

	exportConfiguration(): string {
		return JSON.stringify({
			version: 1,
			groups: this.groups.map(g => ({ name: g.name, priority: g.priority, baseUrl: g.baseUrl })),
			// Секреты и их отпечатки намеренно не экспортируются: ключи передаются
			// только через Aura Hub, а fingerprint позволил бы подтвердить конкретный ключ.
			keys: this.keys.map(k => ({
				name: k.name, baseUrl: k.baseUrl, model: k.model, expectedModel: k.expectedModel,
				group: k.group, priority: k.priority, provider: k.provider, weight: k.weight,
			})),
		}, null, 2);
	}

	async importConfiguration(json: string): Promise<{ groups: number; keys: number }> {
		let parsed: { groups?: Array<{ name?: string; priority?: number; baseUrl?: string }>; keys?: Array<Record<string, unknown>> };
		try {
			parsed = JSON.parse(json);
		} catch {
			throw new Error('Aura API: невалидный JSON конфигурации');
		}
		let groups = 0;
		for (const g of parsed.groups ?? []) {
			const name = String(g?.name ?? '').trim();
			if (!name || this.groups.some(existing => existing.name.toLowerCase() === name.toLowerCase())) { continue; }
			this.createGroup(name, g?.priority, g?.baseUrl);
			groups++;
		}
		let keys = 0;
		for (const k of parsed.keys ?? []) {
			const baseUrl = String(k['baseUrl'] ?? '').trim();
			const model = String(k['model'] ?? '').trim();
			if (!baseUrl || !model) { continue; }
			// Секрет отсутствует по замыслу: ключ добавляется «пустым» и подсветится как нерабочий,
			// пока пользователь не вставит секрет вручную или не получит грант из Aura Hub.
			await this.addKey({
				name: String(k['name'] ?? model),
				baseUrl,
				model,
				expectedModel: k['expectedModel'] ? String(k['expectedModel']) : model,
				group: k['group'] ? String(k['group']) : undefined,
				priority: (k['priority'] as AuraApiKeyPriority) ?? 'medium',
				provider: k['provider'] as AuraProvider | undefined,
				weight: typeof k['weight'] === 'number' ? k['weight'] : undefined,
			}, '');
			keys++;
		}
		return { groups, keys };
	}

	async checkAllQueued(maxParallel: number = QUEUE_PARALLEL): Promise<void> {
		this.checkCts?.cancel();
		this.checkCts = new CancellationTokenSource();
		const limiter = maxParallel === QUEUE_PARALLEL ? this.checkLimiter : new Limiter<unknown>(maxParallel);
		const jobs = this.keys.map(key => limiter.queue(async () => {
			if (this.checkCts?.token.isCancellationRequested) { return; }
			let status = this.getStatus(key.id).health;
			let attempt = 0;
			// backoff на 429: до 3 повторов
			while (attempt < 3 && !this.checkCts?.token.isCancellationRequested) {
				await this.checkKey(key.id);
				status = this.getStatus(key.id).health;
				if (status !== 'ratelimited') { break; }
				attempt++;
				await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS * attempt));
			}
		}));
		await Promise.allSettled(jobs);
	}

	resolveKeyForModel(modelId?: string): IAuraApiKey | undefined {
		const now = Date.now();
		const eligible = (k: IAuraApiKey): boolean => {
			const st = this.getStatus(k.id);
			if (st.cooldownUntil !== undefined && st.cooldownUntil > now) { return false; }
			if (st.health === 'unauthorized' || st.health === 'forbidden') { return false; }
			if (st.ok !== true || st.excludedHighPing) { return false; }
			return true;
		};
		// группы по приоритету, внутри — по weight и ping
		for (const group of this.getGroups()) {
			const pool = this.keys.filter(k => eligible(k) && (this.groups.find(g => g.name === k.group)?.id ?? this.groups[0].id) === group.id);
			if (pool.length === 0) { continue; }
			pool.sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || (this.getStatus(a.id).pingMs ?? 99999) - (this.getStatus(b.id).pingMs ?? 99999));
			return pool[0];
		}
		return undefined;
	}

	maskedSecretLabel(id: string): string {
		const key = this.keys.find(k => k.id === id);
		if (!key) { return '—'; }
		// Показываем только 6 символов солёного отпечатка: сам секрет и его длина не раскрываются.
		return key.secretFingerprint ? `••••${key.secretFingerprint.slice(0, 6)}` : key.name;
	}

	async selectForChat(id: string): Promise<void> {
		const key = this.keys.find(k => k.id === id);
		if (!key) { return; }
		// Мост в чат: активный эндпоинт пишется в настройки, откуда его смогут читать провайдеры моделей.
		await this.configurationService.updateValue('auraApi.chat.baseUrl', key.baseUrl);
		await this.configurationService.updateValue('auraApi.chat.model', key.model);
		this.storageService.store(STORAGE_SELECTED, id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}
}

registerSingleton(IAuraApiKeysService, AuraApiKeysService, InstantiationType.Delayed);

