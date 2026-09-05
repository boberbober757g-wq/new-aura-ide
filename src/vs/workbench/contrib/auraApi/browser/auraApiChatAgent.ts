/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — участник чата по умолчанию для панели.
 *
 * Панель чата отправляет запрос не в языковую модель напрямую, а агенту по умолчанию
 * (`isDefault`). В Code – OSS без расширения Copilot такого агента нет: поле ввода
 * есть, но отправка ничего не делает, а модели Aura API в пикере недоступны. Этот
 * агент закрывает дыру — он берёт выбранную пользователем модель Aura API,
 * прогоняет запрос через ILanguageModelsService и сам крутит цикл вызова
 * инструментов редактора, поэтому агентный режим работает без Copilot-аккаунта.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import {
	IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService,
} from '../../chat/common/participants/chatAgents.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import {
	ChatMessageRole, IChatMessage, IChatMessagePart, ILanguageModelsService,
} from '../../chat/common/languageModels.js';
import { ILanguageModelToolsService, IToolData } from '../../chat/common/tools/languageModelToolsService.js';
import { AURA_API_VENDOR } from './auraApiChatProvider.js';

export const AURA_API_AGENT_ID = 'aura.api.chat';

/** Потолок итераций «модель → инструмент → модель», чтобы зациклившийся агент не работал вечно. */
const MAX_TOOL_ROUNDS = 12;

export class AuraApiChatAgent extends Disposable implements IChatAgentImplementation {

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Модель запроса: выбранная пользователем, иначе любая живая модель Aura API. */
	private resolveModel(request: IChatAgentRequest): string | undefined {
		const auraModels = this.languageModelsService.getLanguageModelIds()
			.filter(id => this.languageModelsService.lookupLanguageModel(id)?.vendor === AURA_API_VENDOR);
		if (request.userSelectedModelId && auraModels.includes(request.userSelectedModelId)) {
			return request.userSelectedModelId;
		}
		return request.userSelectedModelId ?? auraModels[0];
	}

	/** Инструменты, включённые пользователем в пикере, — только в агентном режиме. */
	private resolveTools(request: IChatAgentRequest, modelId: string): IToolData[] {
		if (!request.userSelectedTools) {
			return [];
		}
		const metadata = this.languageModelsService.lookupLanguageModel(modelId);
		if (metadata?.capabilities?.toolCalling === false) {
			return [];
		}
		return [...this.toolsService.getTools(metadata)]
			.filter(tool => request.userSelectedTools?.[tool.id] === true);
	}

	private historyToMessages(history: IChatAgentHistoryEntry[]): IChatMessage[] {
		const messages: IChatMessage[] = [];
		for (const entry of history) {
			messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: entry.request.message }] });
			const text = entry.response
				.map(part => part.kind === 'markdownContent' ? part.content.value : '')
				.filter(Boolean)
				.join('\n');
			if (text) {
				messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: text }] });
			}
		}
		return messages;
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const modelId = this.resolveModel(request);
		if (!modelId) {
			progress([{
				kind: 'warning',
				content: new MarkdownString(localize('auraApi.agent.noModel', "Aura API: нет доступных моделей. Откройте менеджер ключей (Aura API: Открыть менеджер ключей) и добавьте рабочий ключ.")),
			}]);
			return { errorDetails: { message: localize('auraApi.agent.noModelError', "Нет доступных моделей Aura API") } };
		}

		const tools = this.resolveTools(request, modelId);
		const messages: IChatMessage[] = [
			...this.historyToMessages(history),
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] },
		];

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			if (token.isCancellationRequested) {
				return {};
			}

			const response = await this.languageModelsService.sendChatRequest(
				modelId,
				nullExtensionDescription.identifier,
				messages,
				{
					tools: tools.map(tool => ({ name: tool.id, description: tool.modelDescription, inputSchema: tool.inputSchema })),
					toolMode: 1 /* Auto */,
				},
				token,
			);

			let text = '';
			const toolUses: Array<{ name: string; toolCallId: string; parameters: Record<string, unknown> }> = [];
			for await (const chunk of response.stream) {
				for (const part of Array.isArray(chunk) ? chunk : [chunk]) {
					if (part.type === 'text') {
						text += part.value;
						progress([{ kind: 'markdownContent', content: new MarkdownString(part.value) }]);
					} else if (part.type === 'tool_use') {
						toolUses.push({ name: part.name, toolCallId: part.toolCallId, parameters: part.parameters ?? {} });
					}
				}
			}
			await response.result;

			if (toolUses.length === 0) {
				return {};
			}

			// Ответ ассистента с вызовами обязан попасть в историю до результатов,
			// иначе провайдер отвергнет tool-сообщения как «висящие».
			const assistantContent: IChatMessagePart[] = [];
			if (text) {
				assistantContent.push({ type: 'text', value: text });
			}
			for (const use of toolUses) {
				assistantContent.push({ type: 'tool_use', name: use.name, toolCallId: use.toolCallId, parameters: use.parameters });
			}
			messages.push({ role: ChatMessageRole.Assistant, content: assistantContent });

			for (const use of toolUses) {
				const result = await this.invokeTool(request, use, token);
				messages.push({ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: use.toolCallId, value: [{ type: 'text', value: result.text }], isError: result.isError }] });
			}
		}

		progress([{
			kind: 'warning',
			content: new MarkdownString(localize('auraApi.agent.tooManyRounds', "Aura API: превышен лимит в {0} циклов вызова инструментов — запрос остановлен.", MAX_TOOL_ROUNDS)),
		}]);
		return {};
	}

	private async invokeTool(request: IChatAgentRequest, use: { name: string; toolCallId: string; parameters: Record<string, unknown> }, token: CancellationToken): Promise<{ text: string; isError: boolean }> {
		try {
			const result = await this.toolsService.invokeTool({
				callId: use.toolCallId,
				toolId: use.name,
				parameters: use.parameters,
				chatRequestId: request.requestId,
				context: { sessionResource: request.sessionResource },
			}, async input => input.length, token);

			const text = result.content
				.map(part => part.kind === 'text' ? part.value : '')
				.filter(Boolean)
				.join('\n');
			return { text: text || localize('auraApi.agent.toolNoOutput', "(инструмент не вернул текста)"), isError: !!result.toolResultError };
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.logService.warn(`[AuraAPI] tool ${use.name} failed`, message);
			// Ошибку отдаём модели текстом: так она может исправиться сама, а не оборвать запрос.
			return { text: localize('auraApi.agent.toolFailed', "Ошибка инструмента {0}: {1}", use.name, message), isError: true };
		}
	}
}

/** Регистрирует агента Aura как участника чата по умолчанию во всех режимах панели. */
export function registerAuraApiChatAgent(instantiationService: IInstantiationService, chatAgentService: IChatAgentService): IDisposable {
	const store = new DisposableStore();
	store.add(chatAgentService.registerAgent(AURA_API_AGENT_ID, {
		id: AURA_API_AGENT_ID,
		name: 'Aura',
		fullName: 'Aura',
		description: localize('auraApi.agent.description', "Чат на ваших API-ключах через Aura API"),
		isDefault: true,
		isCore: true,
		modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
		slashCommands: [],
		disambiguation: [],
		locations: [ChatAgentLocation.Chat],
		metadata: {},
		extensionId: nullExtensionDescription.identifier,
		extensionVersion: undefined,
		extensionDisplayName: nullExtensionDescription.name,
		extensionPublisherId: nullExtensionDescription.publisher,
	}));
	store.add(chatAgentService.registerAgentImplementation(AURA_API_AGENT_ID, store.add(instantiationService.createInstance(AuraApiChatAgent))));
	return store;
}
