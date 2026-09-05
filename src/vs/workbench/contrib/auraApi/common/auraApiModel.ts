/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — модель данных «имба-менеджера ключей» (Этап 2).
 * Только чистые типы и функции: без DI, DOM и сети — покрывается юнит-тестами.
 * Секреты сюда НЕ попадают в постоянное хранилище: секрет — только ISecretStorageService
 * (ключ вида `auraApi.secret.<keyId>`), здесь — метаданные.
 */

import { StringSHA1 } from '../../../../base/common/hash.js';

export type AuraProvider = 'openai-compatible' | 'anthropic' | 'google' | 'openrouter' | 'litellm';

export interface IAuraApiGroup {
	id: string;
	name: string;
	/** 0 = высший приоритет */
	priority: number;
	color?: string;
	/** baseUrl по умолчанию для ключей группы */
	baseUrl?: string;
}

export type AuraHealthStatus = 'ok' | 'unauthorized' | 'forbidden' | 'ratelimited' | 'notfound' | 'down' | 'unknown';

export interface IAuraApiKeyHealth {
	status: AuraHealthStatus;
	latencyMs?: number;
	checkedAt?: number;
	error?: string;
}

export interface IAuraApiModelEntry {
	id: string;
	available: 'yes' | 'no' | 'unknown';
	verifiedAt?: number;
	source: 'discovered' | 'manual';
	enabledForChat: boolean;
	contextWindow?: number;
	supportsTools?: boolean;
	supportsVision?: boolean;
}

export interface IAuraApiKey {
	id: string;
	label: string;
	groupId: string;
	baseUrl: string;
	provider: AuraProvider;
	/** вес для взвешенного round-robin внутри группы */
	weight: number;
	models: IAuraApiModelEntry[];
	health: IAuraApiKeyHealth;
	cooldownUntil?: number;
	/** fingerprint секрета для дедупликации (сам секрет тут не хранится) */
	secretFingerprint: string;
}

/* ---------------------------------- secrets ---------------------------------- */

export function auraSecretStorageKey(keyId: string): string {
	return `auraApi.secret.${keyId}`;
}

/** Маска для UI/логов: sk-...wxyz */
export function maskSecret(secret: string): string {
	const s = secret.trim();
	if (s.length <= 8) {
		return s.slice(0, 2) + '…';
	}
	return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/**
 * Отпечаток секрета для дедупликации повторной вставки.
 * Солёный: без соли по значению из storage можно перебором подтвердить наличие
 * конкретного ключа, а префикс+длина+хвост фактически раскрывали половину ключа.
 * Соль генерируется локально при первом запуске и хранится рядом с ключами.
 */
export function secretFingerprint(secret: string, salt: string): string {
	const sha = new StringSHA1();
	sha.update(salt);
	sha.update('\u0000');
	sha.update(secret.trim());
	return sha.digest();
}

/* -------------------------------- bulk parsing ------------------------------- */

export interface IAuraKeyDraft {
	label: string;
	key: string;
	baseUrl?: string;
	provider: AuraProvider;
	groupName?: string;
	weight?: number;
}

export interface IAuraBulkParseError {
	line: number;
	text: string;
	reason: string;
}

export interface IAuraBulkParseResult {
	keys: IAuraKeyDraft[];
	errors: IAuraBulkParseError[];
}

const PROVIDER_DEFAULT_BASE_URL: Record<AuraProvider, string> = {
	'openai-compatible': 'https://api.openai.com/v1',
	'anthropic': 'https://api.anthropic.com',
	'google': 'https://generativelanguage.googleapis.com',
	'openrouter': 'https://openrouter.ai',
	'litellm': 'http://localhost:4000',
};

export function defaultBaseUrl(provider: AuraProvider): string {
	return PROVIDER_DEFAULT_BASE_URL[provider];
}

/** Определение провайдера по префиксу ключа и/или хосту baseUrl. */
export function detectProvider(key: string, baseUrl?: string): AuraProvider | undefined {
	const k = key.trim();
	const host = (baseUrl ?? '').toLowerCase();
	if (k.startsWith('sk-ant-')) {
		return 'anthropic';
	}
	if (k.startsWith('sk-or-') || host.includes('openrouter.ai')) {
		return 'openrouter';
	}
	if (k.startsWith('AIza') || host.includes('generativelanguage.googleapis.com')) {
		return 'google';
	}
	if (host.includes('anthropic.com')) {
		return 'anthropic';
	}
	if (host.includes(':4000') || host.includes('litellm')) {
		return 'litellm';
	}
	if (k.startsWith('sk-') || host.length > 0) {
		return 'openai-compatible';
	}
	return undefined;
}

function looksLikeApiKey(value: string): boolean {
	const v = value.trim();
	return v.length >= 16 && !/\s/.test(v) && !v.includes('=');
}

function finalizeDraft(label: string, key: string, baseUrl: string | undefined, groupName: string | undefined, weight: number | undefined, line: number, errors: IAuraBulkParseError[]): IAuraKeyDraft | undefined {
	const k = key.trim();
	if (!looksLikeApiKey(k)) {
		errors.push({ line, text: maskSecret(k), reason: 'не похоже на API-ключ (короткий или содержит пробелы/=)' });
		return undefined;
	}
	const provider = detectProvider(k, baseUrl);
	if (!provider) {
		errors.push({ line, text: maskSecret(k), reason: 'не удалось определить провайдера — укажите baseUrl' });
		return undefined;
	}
	return {
		label: label.trim() || maskSecret(k),
		key: k,
		baseUrl: baseUrl?.trim() || defaultBaseUrl(provider),
		provider,
		groupName: groupName?.trim() || undefined,
		weight: weight !== undefined && Number.isFinite(weight) && weight > 0 ? weight : 1,
	};
}

/**
 * Массовый парсер «вставь что угодно»: сырые ключи по строкам, `label | baseUrl | key`,
 * CSV с заголовком, `.env`-строки, JSON-массив объектов.
 */
export function parseKeysBulk(text: string): IAuraBulkParseResult {
	const keys: IAuraKeyDraft[] = [];
	const errors: IAuraBulkParseError[] = [];
	const trimmed = text.trim();
	if (!trimmed) {
		return { keys, errors };
	}

	// 1) JSON-массив
	if (trimmed.startsWith('[')) {
		try {
			const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
			arr.forEach((obj, i) => {
				if (!obj || typeof obj !== 'object') {
					errors.push({ line: i + 1, text: String(obj), reason: 'элемент не является объектом' });
					return;
				}
				const key = String(obj['key'] ?? obj['apiKey'] ?? obj['api_key'] ?? '');
				const draft = finalizeDraft(
					String(obj['label'] ?? obj['name'] ?? ''),
					key,
					obj['baseUrl'] !== undefined ? String(obj['baseUrl']) : (obj['base_url'] !== undefined ? String(obj['base_url']) : undefined),
					obj['group'] !== undefined ? String(obj['group']) : undefined,
					obj['weight'] !== undefined ? Number(obj['weight']) : undefined,
					i + 1, errors);
				if (draft) {
					keys.push(draft);
				}
			});
		} catch {
			errors.push({ line: 1, text: trimmed.slice(0, 40), reason: 'невалидный JSON' });
		}
		return { keys, errors };
	}

	const lines = trimmed.split(/\r?\n/);

	// 2) CSV с заголовком (первая строка содержит запятую и слово key/apikey)
	const first = lines[0] ?? '';
	if (first.includes(',') && /(^|,)\s*(api_?key|key|token|secret)\s*(,|$)/i.test(first)) {
		const headers = first.split(',').map(h => h.trim().toLowerCase());
		const idx = (names: string[]) => names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1;
		const iKey = idx(['key', 'apikey', 'api_key', 'token', 'secret']);
		const iLabel = idx(['label', 'name', 'title']);
		const iBase = idx(['baseurl', 'base_url', 'url', 'endpoint']);
		const iGroup = idx(['group', 'groupname', 'group_name']);
		for (let i = 1; i < lines.length; i++) {
			const row = lines[i];
			if (!row.trim()) {
				continue;
			}
			const cells = row.split(',').map(c => c.trim());
			const draft = finalizeDraft(
				iLabel >= 0 ? (cells[iLabel] ?? '') : '',
				iKey >= 0 ? (cells[iKey] ?? '') : '',
				iBase >= 0 ? cells[iBase] : undefined,
				iGroup >= 0 ? cells[iGroup] : undefined,
				undefined, i + 1, errors);
			if (draft) {
				keys.push(draft);
			}
		}
		return { keys, errors };
	}

	// 3) Построчный автодетект: .env / `label | baseUrl | key` / сырой ключ
	lines.forEach((raw, i) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			return;
		}
		// .env: OPENAI_API_KEY=sk-...
		const envMatch = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
		if (envMatch && /(API_?KEY|TOKEN|SECRET)/i.test(envMatch[1])) {
			const draft = finalizeDraft(envMatch[1], envMatch[2].replace(/^["']|["']$/g, ''), undefined, undefined, undefined, i + 1, errors);
			if (draft) {
				keys.push(draft);
			}
			return;
		}
		// pipe: label | baseUrl | key   (baseUrl может отсутствовать: label | key)
		if (line.includes('|')) {
			const parts = line.split('|').map(p => p.trim());
			const last = parts[parts.length - 1] ?? '';
			const maybeBase = parts.length >= 3 ? parts[parts.length - 2] : undefined;
			const label = parts.slice(0, Math.max(1, parts.length - (parts.length >= 3 ? 2 : 1))).join(' | ');
			const draft = finalizeDraft(parts.length >= 3 ? label : (parts[0] ?? ''), last, maybeBase, undefined, undefined, i + 1, errors);
			if (draft) {
				keys.push(draft);
			}
			return;
		}
		// сырой ключ
		const draft = finalizeDraft('', line, undefined, undefined, undefined, i + 1, errors);
		if (draft) {
			keys.push(draft);
		}
	});
	return { keys, errors };
}

/* ------------------------- HTTP-классификация и cooldown ---------------------- */

/** Классификация ответа probe/discovery по статус-коду (п. 2 плана). */
export function classifyHttpStatus(status: number): AuraHealthStatus {
	if (status >= 200 && status < 300) {
		return 'ok';
	}
	if (status === 401) {
		return 'unauthorized';
	}
	if (status === 403) {
		return 'forbidden';
	}
	if (status === 404) {
		return 'notfound';
	}
	if (status === 429) {
		return 'ratelimited';
	}
	if (status >= 500) {
		return 'down';
	}
	return 'unknown';
}

/** 429 → 60с, 5xx → 30с, 401 → до ручной перепроверки (Infinity). */
export function cooldownMsForStatus(status: number): number {
	if (status === 429) {
		return 60_000;
	}
	if (status === 401) {
		return Number.POSITIVE_INFINITY;
	}
	if (status >= 500) {
		return 30_000;
	}
	return 0;
}

/**
 * Проверка подлинности модели: прокси часто подменяют дорогую модель дешёвой.
 * Основной сигнал — сравнение запрошенного id с полем `model` в ответе.
 *
 * Важно: многие OpenAI-совместимые прокси вообще не возвращают `model` или возвращают
 * собственный внутренний id (`gpt-4`, `default`, имя маршрута). Это не доказательство
 * подмены, поэтому такой случай даёт «неизвестно» (null), а не низкий процент —
 * иначе честный прокси выглядит мошенником.
 */
export function modelAuthenticityPercent(requestedModel: string, returnedModel: string | undefined, heuristicPercent?: number): number | null {
	const requested = requestedModel.trim();
	const returned = returnedModel?.trim();
	if (!returned) {
		return heuristicPercent ?? null; // провайдер не сказал — не выдумываем число
	}
	const norm = (m: string) => m.toLowerCase()
		.replace(/^.*\//, '')       // openai/gpt-4o → gpt-4o
		.replace(/[-_.\s]/g, '')
		.replace(/(latest|preview|turbo)$/, '');
	const a = norm(requested);
	const b = norm(returned);
	if (a === b) {
		return 100;
	}
	if (a.startsWith(b) || b.startsWith(a)) {
		return 90; // версионный суффикс: glm-5.3 vs glm-5.3-20260101
	}
	if (a.includes(b) || b.includes(a)) {
		return 70; // одно семейство: gpt-4o vs gpt-4o-mini
	}
	// Явно другое имя — но это может быть внутренний id прокси, поэтому не ниже эвристики.
	return heuristicPercent ?? 30;
}

/* --------------------------------- роутер ------------------------------------ */

export interface IAuraRouterState {
	groups: IAuraApiGroup[];
	keys: IAuraApiKey[];
	/** курсор round-robin по группам */
	cursors: Map<string, number>;
}

/** Ключ пригоден: не в cooldown, не мёртв, модель доступна (если запрошена). */
export function isKeyEligible(key: IAuraApiKey, now: number, modelId?: string): boolean {
	if (key.cooldownUntil !== undefined && key.cooldownUntil > now) {
		return false;
	}
	if (key.health.status === 'unauthorized' || key.health.status === 'forbidden') {
		return false;
	}
	if (modelId !== undefined) {
		const model = key.models.find(m => m.id === modelId);
		if (model && (model.available === 'no' || !model.enabledForChat)) {
			return false;
		}
	}
	return true;
}

/** Группы по приоритету (0 — высший), стабильная сортировка. */
export function sortedGroups(groups: IAuraApiGroup[]): IAuraApiGroup[] {
	return [...groups].sort((a, b) => a.priority - b.priority);
}

/** Взвешенный round-robin внутри группы: вероятность пропорциональна weight. */
export function pickWeightedKey(eligible: IAuraApiKey[], cursor: number): { key: IAuraApiKey; nextCursor: number } | undefined {
	if (eligible.length === 0) {
		return undefined;
	}
	const total = eligible.reduce((sum, k) => sum + Math.max(1, k.weight), 0);
	const slot = ((cursor % total) + total) % total;
	let acc = 0;
	for (const k of eligible) {
		acc += Math.max(1, k.weight);
		if (slot < acc) {
			return { key: k, nextCursor: cursor + 1 };
		}
	}
	return { key: eligible[eligible.length - 1], nextCursor: cursor + 1 };
}

/**
 * resolve(modelId): группы по priority → внутри группы взвешенный round-robin,
 * ключи в cooldown и мёртвые (401/403) пропускаются. Чат жив, пока жив хоть один ключ.
 */
export function resolveKey(state: IAuraRouterState, now: number, modelId?: string): IAuraApiKey | undefined {
	for (const group of sortedGroups(state.groups)) {
		const eligible = state.keys.filter(k => k.groupId === group.id && isKeyEligible(k, now, modelId));
		const picked = pickWeightedKey(eligible, state.cursors.get(group.id) ?? 0);
		if (picked) {
			state.cursors.set(group.id, picked.nextCursor);
			return picked.key;
		}
	}
	return undefined;
}

/** Failover: применить исход запроса к ключу (cooldown/статус). */
export function applyRequestOutcome(key: IAuraApiKey, status: number, now: number, error?: string): void {
	const cooldownMs = cooldownMsForStatus(status);
	if (cooldownMs > 0) {
		key.cooldownUntil = cooldownMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : now + cooldownMs;
	}
	key.health = {
		status: classifyHttpStatus(status),
		checkedAt: now,
		error,
		latencyMs: key.health.latencyMs,
	};
}
