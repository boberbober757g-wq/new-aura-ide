/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Aura API — центральная вкладка менеджера ключей (EditorPane + UI). */

import './media/auraApiEditor.css';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraApiEditorInput } from './auraApiEditorInput.js';
import { IAuraApiKeysService, IAuraApiKey, AuraApiKeyPriority } from '../common/auraApiKeys.js';

export class AuraApiEditorPane extends EditorPane {

	static readonly ID = AuraApiEditorInput.ID;

	private rootEl!: HTMLElement;
	private tableBody!: HTMLElement;
	private groupFilter = '';
	private groupSelect?: HTMLSelectElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAuraApiKeysService private readonly keysService: IAuraApiKeysService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(AuraApiEditorPane.ID, group, telemetryService, themeService, storageService);
		this._register(this.keysService.onDidChange(() => this.renderTable()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.aura-api-editor'));

		// --- Панель действий ---
		const toolbar = append(this.rootEl, $('.aura-api-toolbar'));
		this.mkButton(toolbar, '+ Добавить ключ', () => this.showAddForm());
		this.mkButton(toolbar, 'Массовый импорт', () => this.showBulkForm());
		this.mkButton(toolbar, 'Проверить все (очередь)', () => {
			void this.keysService.checkAllQueued().then(() => this.notificationService.info('Проверка всех ключей завершена.'));
		});
		this.mkButton(toolbar, 'Проверить группу', () => this.checkGroup());
		this.mkButton(toolbar, 'Обновить', () => this.renderTable());

		// --- Фильтр по группе ---
		const filterWrap = append(toolbar, $('.aura-api-group-filter'));
		append(filterWrap, $('span')).textContent = 'Группа: ';
		this.groupSelect = append(filterWrap, $('select.aura-api-select')) as HTMLSelectElement;
		this._register(addDisposableListener(this.groupSelect, EventType.CHANGE, () => {
			this.groupFilter = this.groupSelect!.value;
			this.renderTable();
		}));

		// --- Таблица ключей ---
		const tableWrap = append(this.rootEl, $('.aura-api-table-wrap'));
		const table = append(tableWrap, $('table.aura-api-table'));
		const head = append(table, $('tr.aura-api-head'));
		for (const col of ['Название', 'Base URL', 'Модель', 'Группа', 'Приоритет', 'Пинг', 'Статус', 'Модель %', 'Защита %', 'Действия']) {
			append(head, $('th')).textContent = col;
		}
		this.tableBody = append(table, $('tbody'));
	}

	private mkButton(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const b = append(parent, $('button.aura-api-btn')) as HTMLButtonElement;
		b.textContent = label;
		this._register(addDisposableListener(b, EventType.CLICK, run));
		return b;
	}

	private renderTable(): void {
		if (!this.tableBody) { return; }
		this.tableBody.textContent = '';

		// обновить список групп (из сервиса — включая пустые созданные)
		const keys = this.keysService.getKeys();
		const groups = this.keysService.getGroups().map(g => g.name);
		if (this.groupSelect) {
			const prev = this.groupSelect.value;
			this.groupSelect.textContent = '';
			const all = append(this.groupSelect, $('option')) as HTMLOptionElement;
			all.value = ''; all.textContent = 'Все';
			for (const g of groups) {
				const opt = append(this.groupSelect, $('option')) as HTMLOptionElement;
				opt.value = g; opt.textContent = g;
			}
			this.groupSelect.value = groups.includes(prev) ? prev : '';
			this.groupFilter = this.groupSelect.value;
		}

		const visible = keys.filter(k => !this.groupFilter || k.group === this.groupFilter);
		if (visible.length === 0) {
			const row = append(this.tableBody, $('tr'));
			const cell = append(row, $('td.aura-api-empty')) as HTMLTableCellElement;
			cell.colSpan = 10;
			cell.textContent = 'Ключи не добавлены. Нажмите «+ Добавить ключ» или «Массовый импорт».';
			return;
		}

		for (const key of visible) {
			const s = this.keysService.getStatus(key.id);
			const row = append(this.tableBody, $('tr.aura-api-row'));

			append(row, $('td')).textContent = key.name;
			append(row, $('td.aura-api-url')).textContent = key.baseUrl;
			append(row, $('td')).textContent = key.model;
			append(row, $('td')).textContent = key.group ?? '—';

			// Приоритет (селектор)
			const prioCell = append(row, $('td'));
			const prio = append(prioCell, $('select.aura-api-select')) as HTMLSelectElement;
			for (const [value, label] of [['high', 'Высокий'], ['medium', 'Средний'], ['low', 'Низкий']] as Array<[AuraApiKeyPriority, string]>) {
				const opt = append(prio, $('option')) as HTMLOptionElement;
				opt.value = value; opt.textContent = label;
			}
			prio.value = key.priority;
			this._register(addDisposableListener(prio, EventType.CHANGE, () => {
				void this.keysService.updateKey(key.id, { priority: prio.value as AuraApiKeyPriority });
			}));

			// Пинг
			append(row, $('td')).textContent = s.pingMs !== undefined ? `${s.pingMs} мс` : (s.checking ? '…' : '—');

			// Статус / ошибка (health из ядра + cooldown)
			const statusCell = append(row, $('td'));
			const healthLabel: Record<string, string> = { ok: 'OK', unauthorized: '401', forbidden: '403', ratelimited: '429', notfound: '404', down: '5xx', unknown: '?' };
			if (s.cooldownUntil !== undefined && s.cooldownUntil > Date.now()) {
				statusCell.textContent = s.cooldownUntil === Number.POSITIVE_INFINITY ? 'Cooldown: до ручной перепроверки (401)' : `Cooldown до ${new Date(s.cooldownUntil).toLocaleTimeString()}`;
				statusCell.classList.add('aura-api-warn');
			} else if (s.checking) {
				statusCell.textContent = 'Проверка…';
			} else if (s.health && s.health !== 'ok') {
				const hb = append(statusCell, $('span.aura-api-err'));
				hb.textContent = `${healthLabel[s.health] ?? s.health}: ${s.error ?? ''}`;
				hb.title = s.error ?? '';
			} else if (s.ok === true) {
				const ok = append(statusCell, $('span.aura-api-ok'));
				ok.textContent = s.excludedHighPing ? 'Работает, но исключён (высокий пинг)' : 'Работает';
			} else if (s.ok === false) {
				const err = append(statusCell, $('span.aura-api-err'));
				err.textContent = `Ошибка: ${s.error ?? 'неизвестная'}`;
				err.title = s.error ?? '';
			} else {
				statusCell.textContent = 'Не проверен';
			}

			// Подлинность модели %
			append(row, $('td')).textContent = s.authenticityPct !== undefined && s.authenticityPct !== null ? `${s.authenticityPct}%` : '—';

			// Безопасность %
			const secCell = append(row, $('td'));
			if (s.securityPct !== undefined && s.securityPct !== null) {
				secCell.textContent = `${s.securityPct}%`;
				if (s.securityNotes && s.securityNotes.length > 0) {
					secCell.title = 'Замечания: ' + s.securityNotes.join('; ');
					secCell.classList.add('aura-api-warn');
				}
			} else {
				secCell.textContent = '—';
			}

			// Действия
			const actions = append(row, $('td.aura-api-actions'));
			this.mkRowButton(actions, 'Проверить', () => void this.keysService.checkKey(key.id));
			this.mkRowButton(actions, 'Probe', () => this.probeKey(key));
			this.mkRowButton(actions, 'В чат', () => this.selectForChat(key));
			this.mkRowButton(actions, 'Удалить', () => void this.keysService.removeKey(key.id));
		}
	}

	private mkRowButton(parent: HTMLElement, label: string, run: () => void): void {
		const b = append(parent, $('button.aura-api-btn-small')) as HTMLButtonElement;
		b.textContent = label;
		this._register(addDisposableListener(b, EventType.CLICK, run));
	}

	private async probeKey(key: IAuraApiKey): Promise<void> {
		const r = await this.keysService.probeModel(key.id);
		const msg = r.available === 'yes'
			? `Модель ${key.model} доступна, подлинность ${r.authenticityPct ?? '—'}%${r.error ? ` (${r.error})` : ''}`
			: `Модель ${key.model}: ${r.available} — ${r.error ?? 'нет данных'}`;
		if (r.available === 'yes') { this.notificationService.info(msg); } else { this.notificationService.warn(msg); }
	}

	private checkGroup(): void {
		if (!this.groupFilter) {
			this.notificationService.warn('Сначала выберите группу в фильтре.');
			return;
		}
		const groupKeys = this.keysService.getKeys().filter(k => k.group === this.groupFilter);
		for (const k of groupKeys) { void this.keysService.checkKey(k.id); }
		this.notificationService.info(`Запущена проверка группы «${this.groupFilter}» (${groupKeys.length} ключей).`);
	}

	private async selectForChat(key: IAuraApiKey): Promise<void> {
		const s = this.keysService.getStatus(key.id);
		if (s.ok !== true) {
			this.notificationService.warn(`«${key.name}» сначала нужно проверить — запускаю проверку.`);
			await this.keysService.checkKey(key.id);
		}
		const after = this.keysService.getStatus(key.id);
		if (after.ok === true && !after.excludedHighPing) {
			await this.keysService.selectForChat(key.id);
			this.notificationService.info(`«${key.name}» выбран как активный эндпоинт для чата (${key.model} @ ${key.baseUrl}).`);
		} else {
			this.notificationService.warn(`«${key.name}» нельзя использовать: ${after.error ?? 'не прошёл проверку'}.`);
		}
	}

	// --- Формы добавления ---

	private showAddForm(): void {
		const existing = this.rootEl.querySelector('.aura-api-form');
		if (existing) { existing.remove(); return; }
		const form = append(this.rootEl, $('.aura-api-form'));
		append(form, $('h3')).textContent = 'Новый ключ';
		const name = this.formInput(form, 'Название', 'Мой ключ');
		const baseUrl = this.formInput(form, 'Base URL', 'https://api.openai.com/v1');
		const model = this.formInput(form, 'Модель', 'gpt-4o');
		const expected = this.formInput(form, 'Ожидаемая модель (для проверки подлинности, опц.)', '');
		const group = this.formInput(form, 'Группа (опц., новое имя = создать)', '');
		const secret = this.formInput(form, 'API ключ', 'sk-...', true);
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkButton(row, 'Сохранить и проверить', () => {
			if (!baseUrl.value || !model.value || !secret.value) {
				this.notificationService.warn('Заполните Base URL, модель и ключ.');
				return;
			}
			void this.keysService.addKey({
				name: name.value || model.value,
				baseUrl: baseUrl.value.trim(),
				model: model.value.trim(),
				expectedModel: expected.value.trim() || undefined,
				group: group.value.trim() || undefined,
				priority: 'medium',
			}, secret.value.trim());
			form.remove();
		});
		this.mkButton(row, 'Отмена', () => form.remove());
	}

	private showBulkForm(): void {
		const existing = this.rootEl.querySelector('.aura-api-form');
		if (existing) { existing.remove(); return; }
		const form = append(this.rootEl, $('.aura-api-form'));
		append(form, $('h3')).textContent = 'Массовый импорт';
		const hint = append(form, $('p.aura-api-hint'));
		hint.textContent = 'Вставьте что угодно: сырые ключи по строкам (sk-…, sk-ant-…, AIza…), «название | baseUrl | ключ», CSV с заголовком, .env-строки (OPENAI_API_KEY=…) или JSON-массив. Провайдер и baseUrl определятся автоматически; повторная вставка того же ключа будет пропущена.';
		const area = append(form, $('textarea.aura-api-bulk')) as HTMLTextAreaElement;
		area.rows = 10;
		const group = this.formInput(form, 'Группа для всех (опц., новое имя = создать)', '');
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkButton(row, 'Импортировать и проверить', () => {
			void this.keysService.bulkImport(area.value, group.value.trim() || undefined).then(r => {
				const errNote = r.errors.length > 0 ? ` Ошибки: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? ` (+${r.errors.length - 3})` : ''}` : '';
				this.notificationService.info(`Импортировано: ${r.added}, пропущено: ${r.skipped}.${errNote}`);
				if (r.added > 0) { void this.keysService.checkAllQueued(); }
			});
			form.remove();
		});
		this.mkButton(row, 'Отмена', () => form.remove());
	}

	private formInput(parent: HTMLElement, label: string, placeholder: string, password = false): HTMLInputElement {
		const wrap = append(parent, $('.aura-api-field'));
		append(wrap, $('label')).textContent = label;
		const input = append(wrap, $('input.aura-api-input')) as HTMLInputElement;
		input.type = password ? 'password' : 'text';
		input.placeholder = placeholder;
		return input;
	}

	override layout(_dimension: Dimension): void {
		this.renderTable();
	}

}
