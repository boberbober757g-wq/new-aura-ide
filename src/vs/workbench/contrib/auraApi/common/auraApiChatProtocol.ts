/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — чистый протокольный слой чата (OpenAI-совместимый).
 * Без DI, DOM и сети: конвертация сообщений, маппинг инструментов, разбор SSE-дельт
 * с накоплением tool_calls и usage, оценка токенов. Полностью покрывается юнит-тестами.
 */

/* --------------------------------- сообщения --------------------------------- */

export interface IOaiToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface IOaiMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: IOaiToolCall[];
	tool_call_id?: string;
}

export interface IOaiTool {
	type: 'function';
	function: { name: string; description: string; parameters: object };
}

/** Роли из ILanguageModelsService (ChatMessageRole: System=0, User=1, Assistant=2). */
export const enum AuraChatRole { System = 0, User = 1, Assistant = 2 }

interface IGenericPart { type?: string; value?: unknown; name?: string; toolCallId?: string; parameters?: unknown }
interface IGenericMessage { role: number; content: readonly IGenericPart[] }

function partText(part: IGenericPart): string {
	if (part.type === 'text' && typeof part.value === 'string') {
		return part.value;
	}
	return '';
}

/**
 * Конвертация внутренних сообщений чата в OpenAI-формат.
 * Части `tool_use` становятся `tool_calls` ассистента, части `tool_result` — отдельными
 * сообщениями роли `tool`; без этого модель не видит результат вызова и зацикливается.
 */
export function toOpenAIMessages(messages: readonly IGenericMessage[], systemPrompt?: string): IOaiMessage[] {
	const out: IOaiMessage[] = [];
	const system = (systemPrompt ?? '').trim();
	if (system) {
		out.push({ role: 'system', content: system });
	}
	for (const message of messages) {
		const role = message.role === AuraChatRole.System ? 'system'
			: message.role === AuraChatRole.Assistant ? 'assistant' : 'user';

		const text = message.content.map(partText).filter(Boolean).join('\n');
		const toolCalls: IOaiToolCall[] = [];
		const toolResults: IOaiMessage[] = [];

		for (const part of message.content) {
			if (part.type === 'tool_use' && typeof part.toolCallId === 'string' && typeof part.name === 'string') {
				toolCalls.push({
					id: part.toolCallId,
					type: 'function',
					function: { name: part.name, arguments: JSON.stringify(part.parameters ?? {}) },
				});
			} else if (part.type === 'tool_result' && typeof part.toolCallId === 'string') {
				const value = Array.isArray(part.value) ? (part.value as IGenericPart[]).map(partText).filter(Boolean).join('\n') : '';
				toolResults.push({ role: 'tool', content: value, tool_call_id: part.toolCallId });
			}
		}

		if (text || toolCalls.length > 0) {
			out.push({
				role,
				content: text || null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		}
		out.push(...toolResults);
	}
	return out;
}

interface IGenericTool { name?: unknown; description?: unknown; inputSchema?: unknown }

/** Маппинг инструментов редактора в OpenAI `tools`. Инструменты без имени отбрасываются. */
export function toOpenAITools(tools: readonly unknown[] | undefined): IOaiTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	const mapped: IOaiTool[] = [];
	for (const raw of tools) {
		const tool = raw as IGenericTool;
		if (typeof tool?.name !== 'string' || !tool.name) {
			continue;
		}
		mapped.push({
			type: 'function',
			function: {
				name: tool.name,
				description: typeof tool.description === 'string' ? tool.description : '',
				parameters: (typeof tool.inputSchema === 'object' && tool.inputSchema !== null)
					? tool.inputSchema as object
					: { type: 'object', properties: {} },
			},
		});
	}
	return mapped.length > 0 ? mapped : undefined;
}

/** LanguageModelChatToolMode: Auto = 1, Required = 2. */
export function toOpenAIToolChoice(toolMode: number | undefined, hasTools: boolean): 'auto' | 'required' | undefined {
	if (!hasTools) {
		return undefined;
	}
	return toolMode === 2 ? 'required' : 'auto';
}

/* ----------------------------------- SSE ------------------------------------- */

export interface IAuraUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface IAuraToolCallDelta {
	toolCallId: string;
	name: string;
	/** Сырые аргументы: приходят кусками JSON-строки, накапливаются по индексу. */
	argumentsText: string;
}

export type AuraStreamEvent =
	| { kind: 'text'; value: string }
	| { kind: 'tool_call'; call: IAuraToolCallDelta }
	| { kind: 'usage'; usage: IAuraUsage }
	| { kind: 'done' };

/**
 * Инкрементальный разбор SSE-потока OpenAI-совместимого API.
 * Держит незавершённый хвост буфера (чанк может разрезать и строку, и JSON) и
 * накапливает `tool_calls` по индексу до `finish_reason`, после чего отдаёт их целиком.
 */
export class AuraSseParser {

	private buffer = '';
	private readonly toolCalls = new Map<number, IAuraToolCallDelta>();
	private finished = false;

	/** Скормить очередной кусок текста, получить готовые события. */
	push(chunk: string): AuraStreamEvent[] {
		this.buffer += chunk;
		const events: AuraStreamEvent[] = [];
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) {
				continue;
			}
			const payload = trimmed.slice(5).trim();
			if (payload === '[DONE]') {
				events.push(...this.flush());
				continue;
			}
			let json: {
				choices?: Array<{
					delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
					finish_reason?: string | null;
				}>;
				usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
			};
			try {
				json = JSON.parse(payload);
			} catch {
				continue; // битый/неполный чанк: следующий data: восстановит поток
			}

			const choice = json.choices?.[0];
			const content = choice?.delta?.content;
			if (typeof content === 'string' && content.length > 0) {
				events.push({ kind: 'text', value: content });
			}
			const deltaToolCalls = choice?.delta?.tool_calls ?? [];
			for (let i = 0; i < deltaToolCalls.length; i++) {
				const call = deltaToolCalls[i];
				const slot = call.index ?? i;
				const existing = this.toolCalls.get(slot) ?? { toolCallId: '', name: '', argumentsText: '' };
				this.toolCalls.set(slot, {
					toolCallId: call.id ?? existing.toolCallId,
					name: call.function?.name ?? existing.name,
					argumentsText: existing.argumentsText + (call.function?.arguments ?? ''),
				});
			}
			if (json.usage) {
				events.push({
					kind: 'usage',
					usage: {
						promptTokens: json.usage.prompt_tokens ?? 0,
						completionTokens: json.usage.completion_tokens ?? 0,
						totalTokens: json.usage.total_tokens ?? (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
					},
				});
			}
			if (choice?.finish_reason) {
				events.push(...this.flush());
			}
		}
		return events;
	}

	/** Завершить поток: отдать накопленные вызовы инструментов ровно один раз. */
	flush(): AuraStreamEvent[] {
		if (this.finished) {
			return [];
		}
		this.finished = true;
		const events: AuraStreamEvent[] = [];
		for (const call of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)) {
			if (call.name) {
				events.push({ kind: 'tool_call', call });
			}
		}
		this.toolCalls.clear();
		events.push({ kind: 'done' });
		return events;
	}
}

/** Аргументы вызова инструмента: модели иногда шлют пустую строку или мусорный хвост. */
export function parseToolArguments(argumentsText: string): Record<string, unknown> {
	const text = argumentsText.trim();
	if (!text) {
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		return (typeof parsed === 'object' && parsed !== null) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

/* --------------------------------- токены ------------------------------------ */

/**
 * Оценка токенов без внешнего BPE-энкодера (в форк нельзя тянуть рантайм-зависимость).
 * Считается по классам символов: латиница ≈ 4 символа/токен, кириллица и CJK дороже,
 * пунктуация и переводы строк в коде почти всегда отдельный токен. Ошибка ~10–15 %
 * против cl100k вместо 1.5–2× у наивного `length / 4`.
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let latin = 0, cyrillic = 0, cjk = 0, digits = 0, punctuation = 0, whitespace = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		if (ch === ' ' || ch === '\t') {
			whitespace++;
		} else if (ch === '\n' || ch === '\r') {
			punctuation++;
		} else if (code >= 0x30 && code <= 0x39) {
			digits++;
		} else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
			latin++;
		} else if ((code >= 0x400 && code <= 0x4ff) || (code >= 0x500 && code <= 0x52f)) {
			cyrillic++;
		} else if (code >= 0x3000 && code <= 0x9fff || code >= 0xac00 && code <= 0xd7af) {
			cjk++;
		} else {
			punctuation++;
		}
	}
	const tokens =
		latin / 4 +
		cyrillic / 2 +
		cjk +
		digits / 2.5 +
		punctuation +
		whitespace / 8;
	return Math.max(1, Math.ceil(tokens));
}

/* --------------------------------- бюджеты ----------------------------------- */

export interface IAuraUsageRecord {
	keyId: string;
	model: string;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	at: number;
}

/** Цена за 1M токенов (вход/выход). Неизвестные модели считаются бесплатными — не врём числом. */
const MODEL_PRICES: ReadonlyArray<{ match: RegExp; input: number; output: number }> = [
	{ match: /^gpt-4o-mini/, input: 0.15, output: 0.6 },
	{ match: /^gpt-4o/, input: 2.5, output: 10 },
	{ match: /^gpt-4\.1-mini/, input: 0.4, output: 1.6 },
	{ match: /^gpt-4\.1/, input: 2, output: 8 },
	{ match: /^o3/, input: 2, output: 8 },
	{ match: /^o4-mini/, input: 1.1, output: 4.4 },
	{ match: /^claude-(opus|3-opus)/, input: 15, output: 75 },
	{ match: /^claude-(sonnet|3-5-sonnet)/, input: 3, output: 15 },
	{ match: /^claude-haiku/, input: 0.8, output: 4 },
	{ match: /^gemini-.*-pro/, input: 1.25, output: 10 },
	{ match: /^gemini-.*-flash/, input: 0.3, output: 2.5 },
	{ match: /^deepseek/, input: 0.28, output: 0.42 },
];

/** Стоимость запроса в долларах по прайс-таблице; 0 для незнакомых моделей. */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
	const id = model.trim().toLowerCase().replace(/^.*\//, '');
	const price = MODEL_PRICES.find(p => p.match.test(id));
	if (!price) {
		return 0;
	}
	return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

/** Суммарный расход по ключу за последние `windowMs` (по умолчанию сутки). */
export function spentUsdSince(records: readonly IAuraUsageRecord[], keyId: string, now: number, windowMs = 24 * 60 * 60 * 1000): number {
	return records
		.filter(r => r.keyId === keyId && now - r.at <= windowMs)
		.reduce((sum, r) => sum + r.costUsd, 0);
}
