/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — юнит-тесты ядра Этапа 2: bulk-парсер, классификатор HTTP, роутер.
 * Запуск: ./scripts/test.sh (mocha, suite/test-глобалы).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	applyRequestOutcome, auraSecretStorageKey, classifyHttpStatus, cooldownMsForStatus,
	detectProvider, isKeyEligible, maskSecret, modelAuthenticityPercent, parseKeysBulk,
	pickWeightedKey, resolveKey, secretFingerprint,
	type IAuraApiGroup, type IAuraApiKey, type IAuraRouterState,
} from '../../common/auraApiModel.js';

function makeKey(partial: Partial<IAuraApiKey> & { id: string; groupId: string }): IAuraApiKey {
	return {
		label: partial.id,
		baseUrl: 'https://api.openai.com/v1',
		provider: 'openai-compatible',
		weight: 1,
		models: [],
		health: { status: 'unknown' },
		secretFingerprint: 'fp',
		...partial,
	};
}

function makeGroup(id: string, priority: number): IAuraApiGroup {
	return { id, name: id, priority };
}

function makeState(groups: IAuraApiGroup[], keys: IAuraApiKey[]): IAuraRouterState {
	return { groups, keys, cursors: new Map() };
}

const SK = 'sk-proj-abcdef1234567890ABCD';
const SK2 = 'sk-proj-zzzzzz9876543210WXYZ';

suite('AuraApiModel — bulk-парсер', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('сырой ключ по строке → openai-compatible с дефолтным baseUrl', () => {
		const r = parseKeysBulk(SK);
		assert.strictEqual(r.errors.length, 0);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].provider, 'openai-compatible');
		assert.strictEqual(r.keys[0].baseUrl, 'https://api.openai.com/v1');
	});

	test('несколько сырых ключей + комментарии и пустые строки', () => {
		const r = parseKeysBulk(`# мои ключи\n${SK}\n\n${SK2}\n`);
		assert.strictEqual(r.keys.length, 2);
		assert.strictEqual(r.errors.length, 0);
	});

	test('.env-строка с кавычками', () => {
		const r = parseKeysBulk(`OPENAI_API_KEY="${SK}"`);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].label, 'OPENAI_API_KEY');
		assert.strictEqual(r.keys[0].key, SK);
	});

	test('pipe-формат label | baseUrl | key', () => {
		const r = parseKeysBulk(`Мой прокси | https://proxy.example.com/v1 | ${SK}`);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].label, 'Мой прокси');
		assert.strictEqual(r.keys[0].baseUrl, 'https://proxy.example.com/v1');
		assert.strictEqual(r.keys[0].provider, 'openai-compatible');
	});

	test('pipe-формат label | key (baseUrl дефолтный)', () => {
		const r = parseKeysBulk(`Рабочий | ${SK}`);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].baseUrl, 'https://api.openai.com/v1');
	});

	test('CSV с заголовком', () => {
		const r = parseKeysBulk(`label,baseUrl,key\nProd,https://api.openai.com/v1,${SK}\nDev,,${SK2}\n`);
		assert.strictEqual(r.errors.length, 0);
		assert.strictEqual(r.keys.length, 2);
		assert.strictEqual(r.keys[0].label, 'Prod');
		assert.strictEqual(r.keys[1].label, 'Dev');
		assert.strictEqual(r.keys[1].baseUrl, 'https://api.openai.com/v1');
	});

	test('JSON-массив объектов', () => {
		const r = parseKeysBulk(JSON.stringify([{ name: 'A', key: SK, group: 'prod' }, { key: SK2 }]));
		assert.strictEqual(r.errors.length, 0);
		assert.strictEqual(r.keys.length, 2);
		assert.strictEqual(r.keys[0].groupName, 'prod');
	});

	test('невалидный JSON → ошибка, не падение', () => {
		const r = parseKeysBulk('[{"key":');
		assert.strictEqual(r.keys.length, 0);
		assert.strictEqual(r.errors.length, 1);
	});

	test('мусорная строка → ошибка с замаскированным текстом', () => {
		const r = parseKeysBulk('hello world');
		assert.strictEqual(r.keys.length, 0);
		assert.strictEqual(r.errors.length, 1);
		assert.ok(!r.errors[0].text.includes('hello world') || r.errors[0].text.length < 12);
	});

	test('пустой ввод', () => {
		assert.deepStrictEqual(parseKeysBulk('   '), { keys: [], errors: [] });
	});
});

suite('AuraApiModel — провайдеры и секреты', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('detectProvider по префиксам и хостам', () => {
		assert.strictEqual(detectProvider('sk-ant-abc1234567890123'), 'anthropic');
		assert.strictEqual(detectProvider('sk-or-v1-abc1234567890123'), 'openrouter');
		assert.strictEqual(detectProvider('AIzaSyAbc1234567890'), 'google');
		assert.strictEqual(detectProvider('sk-abc1234567890123', 'https://host:4000/v1'), 'litellm');
		assert.strictEqual(detectProvider(SK), 'openai-compatible');
		assert.strictEqual(detectProvider('short'), undefined);
	});

	test('маскирование и fingerprint', () => {
		assert.strictEqual(maskSecret(SK), 'sk-…0ABCD');
		assert.strictEqual(secretFingerprint(SK, 'salt-1'), secretFingerprint(SK, 'salt-1'));
		assert.notStrictEqual(secretFingerprint(SK, 'salt-1'), secretFingerprint(SK2, 'salt-1'));
		// Соль обязательна: без неё отпечаток можно перебрать по значению из storage.
		assert.notStrictEqual(secretFingerprint(SK, 'salt-1'), secretFingerprint(SK, 'salt-2'));
		assert.ok(!secretFingerprint(SK, 'salt-1').includes(SK.slice(0, 4)));
		assert.strictEqual(auraSecretStorageKey('k1'), 'auraApi.secret.k1');
		assert.ok(!auraSecretStorageKey('k1').includes(SK));
	});
});

suite('AuraApiModel — классификатор HTTP и cooldown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifyHttpStatus', () => {
		assert.strictEqual(classifyHttpStatus(200), 'ok');
		assert.strictEqual(classifyHttpStatus(401), 'unauthorized');
		assert.strictEqual(classifyHttpStatus(403), 'forbidden');
		assert.strictEqual(classifyHttpStatus(404), 'notfound');
		assert.strictEqual(classifyHttpStatus(429), 'ratelimited');
		assert.strictEqual(classifyHttpStatus(500), 'down');
		assert.strictEqual(classifyHttpStatus(418), 'unknown');
	});

	test('cooldownMsForStatus: 429→60с, 5xx→30с, 401→навсегда', () => {
		assert.strictEqual(cooldownMsForStatus(429), 60_000);
		assert.strictEqual(cooldownMsForStatus(503), 30_000);
		assert.strictEqual(cooldownMsForStatus(401), Number.POSITIVE_INFINITY);
		assert.strictEqual(cooldownMsForStatus(200), 0);
	});

	test('modelAuthenticityPercent: declared vs returned', () => {
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', 'gpt-4o'), 100);
		// Регистр, разделители и префикс провайдера не влияют на совпадение.
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', 'openai/GPT_4o'), 100);
		// Версионный суффикс — та же модель, а не подмена.
		assert.strictEqual(modelAuthenticityPercent('glm-5.3', 'glm-5.3-20260101'), 90);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', 'gpt-4o-mini'), 90);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o-2024', 'llama-3-8b'), 30);
		// Молчание провайдера — «неизвестно», а не обвинение в подмене.
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', undefined), null);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', ''), null);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', undefined, 80), 80);
		// Самоотчёт модели не должен занижать оценку ниже собственной эвристики.
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', 'internal-route-7', 80), 80);
	});
});

suite('AuraApiModel — роутер и failover', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const NOW = 1_000_000;

	test('приоритет групп: сначала 0', () => {
		const state = makeState(
			[makeGroup('low', 5), makeGroup('high', 0)],
			[makeKey({ id: 'k-low', groupId: 'low' }), makeKey({ id: 'k-high', groupId: 'high' })]);
		assert.strictEqual(resolveKey(state, NOW)?.id, 'k-high');
	});

	test('ключ в cooldown пропускается, failover на живой', () => {
		const dead = makeKey({ id: 'k-dead', groupId: 'g', cooldownUntil: NOW + 60_000 });
		const alive = makeKey({ id: 'k-alive', groupId: 'g' });
		assert.strictEqual(resolveKey(makeState([makeGroup('g', 0)], [dead, alive]), NOW)?.id, 'k-alive');
	});

	test('все мёртвы → undefined', () => {
		const dead = makeKey({ id: 'k1', groupId: 'g', health: { status: 'unauthorized' } });
		assert.strictEqual(resolveKey(makeState([makeGroup('g', 0)], [dead]), NOW), undefined);
	});

	test('401/403 делают ключ непригодным навсегда', () => {
		assert.strictEqual(isKeyEligible(makeKey({ id: 'k', groupId: 'g', health: { status: 'unauthorized' } }), NOW), false);
		assert.strictEqual(isKeyEligible(makeKey({ id: 'k', groupId: 'g', health: { status: 'forbidden' } }), NOW), false);
	});

	test('фильтр по модели: available=no или выключена для чата → пропуск', () => {
		const k = makeKey({ id: 'k', groupId: 'g', models: [{ id: 'gpt-4o', available: 'no', source: 'discovered', enabledForChat: true }] });
		assert.strictEqual(isKeyEligible(k, NOW, 'gpt-4o'), false);
		assert.strictEqual(isKeyEligible(k, NOW, 'gpt-4o-mini'), true); // модель неизвестна ключу — не блокируем
	});

	test('round-robin внутри группы', () => {
		const state = makeState([makeGroup('g', 0)], [makeKey({ id: 'a', groupId: 'g' }), makeKey({ id: 'b', groupId: 'g' })]);
		const first = resolveKey(state, NOW)?.id;
		const second = resolveKey(state, NOW)?.id;
		assert.notStrictEqual(first, second);
	});

	test('взвешенный round-robin: weight=3 против 1', () => {
		const heavy = makeKey({ id: 'heavy', groupId: 'g', weight: 3 });
		const light = makeKey({ id: 'light', groupId: 'g', weight: 1 });
		const picks = [0, 1, 2, 3].map(c => pickWeightedKey([heavy, light], c)?.key.id);
		assert.deepStrictEqual(picks, ['heavy', 'heavy', 'heavy', 'light']);
	});

	test('applyRequestOutcome: 429 ставит cooldown 60с', () => {
		const k = makeKey({ id: 'k', groupId: 'g' });
		applyRequestOutcome(k, 429, NOW);
		assert.strictEqual(k.health.status, 'ratelimited');
		assert.strictEqual(k.cooldownUntil, NOW + 60_000);
		assert.strictEqual(isKeyEligible(k, NOW), false);
		assert.strictEqual(isKeyEligible(k, NOW + 61_000), true);
	});

	test('applyRequestOutcome: 401 — cooldown навсегда', () => {
		const k = makeKey({ id: 'k', groupId: 'g' });
		applyRequestOutcome(k, 401, NOW);
		assert.strictEqual(k.cooldownUntil, Number.POSITIVE_INFINITY);
		assert.strictEqual(isKeyEligible(k, NOW + 10_000_000_000), false);
	});
});
