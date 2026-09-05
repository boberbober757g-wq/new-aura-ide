/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — юнит-тесты протокольного слоя чата: конвертация сообщений, маппинг инструментов,
 * разбор SSE (включая рваные чанки и накопление tool_calls), оценка токенов и стоимости.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AuraSseParser, AuraChatRole, estimateCostUsd, estimateTokens, parseToolArguments, spentUsdSince,
	toOpenAIMessages, toOpenAITools, toOpenAIToolChoice, type AuraStreamEvent,
} from '../../common/auraApiChatProtocol.js';

function texts(events: AuraStreamEvent[]): string {
	return events.filter(e => e.kind === 'text').map(e => e.value).join('');
}

suite('AuraApiChatProtocol — сообщения и инструменты', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('системный промпт идёт первым сообщением', () => {
		const out = toOpenAIMessages([{ role: AuraChatRole.User, content: [{ type: 'text', value: 'привет' }] }], 'будь краток');
		assert.deepStrictEqual(out, [
			{ role: 'system', content: 'будь краток' },
			{ role: 'user', content: 'привет' },
		]);
	});

	test('пустой системный промпт не добавляется', () => {
		const out = toOpenAIMessages([{ role: AuraChatRole.User, content: [{ type: 'text', value: 'a' }] }], '   ');
		assert.strictEqual(out.length, 1);
	});

	test('tool_use становится tool_calls ассистента, tool_result — сообщением роли tool', () => {
		const out = toOpenAIMessages([
			{ role: AuraChatRole.Assistant, content: [{ type: 'tool_use', name: 'readFile', toolCallId: 'call_1', parameters: { path: 'a.ts' } }] },
			{ role: AuraChatRole.User, content: [{ type: 'tool_result', toolCallId: 'call_1', value: [{ type: 'text', value: 'содержимое' }] }] },
		]);
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[0].role, 'assistant');
		assert.deepStrictEqual(out[0].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a.ts"}' } }]);
		assert.deepStrictEqual(out[1], { role: 'tool', content: 'содержимое', tool_call_id: 'call_1' });
	});

	test('маппинг инструментов и tool_choice', () => {
		const tools = toOpenAITools([{ name: 'edit', description: 'правка', inputSchema: { type: 'object' } }, { description: 'без имени' }]);
		assert.strictEqual(tools?.length, 1);
		assert.deepStrictEqual(tools![0], { type: 'function', function: { name: 'edit', description: 'правка', parameters: { type: 'object' } } });
		assert.strictEqual(toOpenAITools([]), undefined);
		assert.strictEqual(toOpenAIToolChoice(1, true), 'auto');
		assert.strictEqual(toOpenAIToolChoice(2, true), 'required');
		assert.strictEqual(toOpenAIToolChoice(undefined, true), 'auto');
		assert.strictEqual(toOpenAIToolChoice(1, false), undefined);
	});
});

suite('AuraApiChatProtocol — SSE-парсер', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('текстовые дельты собираются по порядку', () => {
		const parser = new AuraSseParser();
		const events = [
			...parser.push('data: {"choices":[{"delta":{"content":"При"}}]}\n'),
			...parser.push('data: {"choices":[{"delta":{"content":"вет"}}]}\n'),
		];
		assert.strictEqual(texts(events), 'Привет');
	});

	test('чанк, разрезавший JSON посередине, не теряет текст', () => {
		const parser = new AuraSseParser();
		const first = parser.push('data: {"choices":[{"delta":{"con');
		assert.strictEqual(texts(first), '');
		const second = parser.push('tent":"склеено"}}]}\n');
		assert.strictEqual(texts(second), 'склеено');
	});

	test('tool_calls накапливаются по индексу и отдаются на finish_reason', () => {
		const parser = new AuraSseParser();
		parser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","function":{"name":"editFile","arguments":"{\\"pa"}}]}}]}\n');
		parser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n');
		const done = parser.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n');
		const calls = done.filter(e => e.kind === 'tool_call');
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].call.toolCallId, 'call_7');
		assert.strictEqual(calls[0].call.name, 'editFile');
		assert.deepStrictEqual(parseToolArguments(calls[0].call.argumentsText), { path: 'a.ts' });
	});

	test('несколько инструментов отдаются в порядке индексов ровно один раз', () => {
		const parser = new AuraSseParser();
		parser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"second","arguments":"{}"}},{"index":0,"id":"a","function":{"name":"first","arguments":"{}"}}]}}]}\n');
		const events = parser.push('data: [DONE]\n');
		const names = events.filter(e => e.kind === 'tool_call').map(e => e.call.name);
		assert.deepStrictEqual(names, ['first', 'second']);
		assert.deepStrictEqual(parser.flush(), []);
	});

	test('usage разбирается из финального чанка', () => {
		const parser = new AuraSseParser();
		const events = parser.push('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":30}}\n');
		const usage = events.find(e => e.kind === 'usage');
		assert.deepStrictEqual(usage?.usage, { promptTokens: 12, completionTokens: 30, totalTokens: 42 });
	});

	test('битый JSON пропускается, поток продолжается', () => {
		const parser = new AuraSseParser();
		parser.push('data: {не json}\n');
		const events = parser.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
		assert.strictEqual(texts(events), 'ok');
	});

	test('аргументы: пустые и мусорные дают пустой объект', () => {
		assert.deepStrictEqual(parseToolArguments(''), {});
		assert.deepStrictEqual(parseToolArguments('{"a":'), {});
		assert.deepStrictEqual(parseToolArguments('"строка"'), {});
	});
});

suite('AuraApiChatProtocol — токены и бюджеты', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('кириллица дороже латиницы при равной длине', () => {
		const latin = estimateTokens('abcdefghijklmnop');
		const cyrillic = estimateTokens('абвгдеёжзийклмно');
		assert.ok(cyrillic > latin, `${cyrillic} > ${latin}`);
	});

	test('пустая строка — ноль токенов, непустая — минимум один', () => {
		assert.strictEqual(estimateTokens(''), 0);
		assert.ok(estimateTokens('a') >= 1);
	});

	test('стоимость по прайс-таблице, незнакомая модель — 0', () => {
		assert.ok(Math.abs(estimateCostUsd('gpt-4o', 1_000_000, 0) - 2.5) < 1e-9);
		assert.ok(Math.abs(estimateCostUsd('openai/gpt-4o-mini', 0, 1_000_000) - 0.6) < 1e-9);
		assert.strictEqual(estimateCostUsd('какая-то-локалка', 1000, 1000), 0);
	});

	test('расход за сутки суммируется только по своему ключу и окну', () => {
		const now = 1_000_000_000;
		const day = 24 * 60 * 60 * 1000;
		const records = [
			{ keyId: 'k1', model: 'm', promptTokens: 0, completionTokens: 0, costUsd: 1, at: now - 1000 },
			{ keyId: 'k1', model: 'm', promptTokens: 0, completionTokens: 0, costUsd: 2, at: now - day - 1000 },
			{ keyId: 'k2', model: 'm', promptTokens: 0, completionTokens: 0, costUsd: 5, at: now },
		];
		assert.strictEqual(spentUsdSince(records, 'k1', now), 1);
		assert.strictEqual(spentUsdSince(records, 'k2', now), 5);
	});
});
