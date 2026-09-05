/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aura API — встроенный плагин Aura Market.
 * Регистрация (вкладка менеджера, иконка слева, команда, провайдер чата) происходит ТОЛЬКО
 * если плагин установлен через Aura Market (флаг auraMarket.installed.aura-api).
 * Клик по иконке слева сразу открывает центральную вкладку.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../common/editor.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { registerAuraApiChatAgent } from './auraApiChatAgent.js';
import { AuraApiEditorPane } from './auraApiEditorPane.js';
import { AuraApiEditorInput, AuraApiEditorInputSerializer } from './auraApiEditorInput.js';
import { AuraApiChatProvider, AURA_API_VENDOR, AURA_API_SYSTEM_PROMPT_SETTING, AURA_API_DAILY_BUDGET_SETTING } from './auraApiChatProvider.js';
import { IAuraApiKeysService } from '../common/auraApiKeys.js';
import { auraMarketInstalledKey } from '../../auraMarket/common/auraMarketCatalog.js';

export const AURA_API_OPEN_COMMAND_ID = 'auraApi.openManager';
export const AURA_API_VIEW_CONTAINER_ID = 'workbench.view.auraApi';
const AURA_API_LAUNCHER_VIEW_ID = 'auraApi.launcher';

// Иконка плагина (в activity bar и в заголовке вкладки)
export const auraApiViewIcon = registerIcon('aura-api-view-icon', Codicon.key, localize('auraApiViewIcon', 'Icon of the Aura API plugin.'));

// --- Иконка слева: клик = сразу открыть вкладку менеджера и закрыть пустой сайдбар ---
class AuraApiLauncherViewPane extends ViewPane {
	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// Сразу открываем вкладку менеджера Aura API и закрываем пустой сайдбар
		void this.commandService.executeCommand(AURA_API_OPEN_COMMAND_ID);
		void this.viewsService.closeViewContainer(AURA_API_VIEW_CONTAINER_ID);
	}
}

let registered = false;

/** Регистрирует вкладку менеджера, иконку слева, команду и мост в чат. Вызывается один раз. */
function registerAuraApiPlugin(instantiationService: IInstantiationService): void {
	if (registered) { return; }
	registered = true;

	// Центральная вкладка менеджера ключей
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(AuraApiEditorPane, AuraApiEditorPane.ID, localize('auraApiEditor', "Aura API")),
		[new SyncDescriptor(AuraApiEditorInput)]
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AuraApiEditorInput.ID, AuraApiEditorInputSerializer);

	// Иконка слева: клик по ней сразу открывает вкладку
	const auraApiContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
		id: AURA_API_VIEW_CONTAINER_ID,
		title: localize2('auraApi', "Aura API"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AURA_API_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		icon: auraApiViewIcon,
		hideIfEmpty: false,
		order: 7,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

	Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
		id: AURA_API_LAUNCHER_VIEW_ID,
		name: localize2('auraApi.launcher', "Aura API"),
		containerIcon: auraApiViewIcon,
		ctorDescriptor: new SyncDescriptor(AuraApiLauncherViewPane),
		canToggleVisibility: true,
		canMoveView: true,
	}], auraApiContainer);

	// Команда: открыть менеджер
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: AURA_API_OPEN_COMMAND_ID,
				title: localize2('auraApi.openManager', "Aura API: Открыть менеджер ключей"),
				category: localize2('auraApi.category', "Aura API"),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			const editorService = accessor.get(IEditorService);
			const instantiation = accessor.get(IInstantiationService);
			void editorService.openEditor(instantiation.createInstance(AuraApiEditorInput), { pinned: true });
		}
	});

	// Провайдер моделей чата: здоровые ключи Aura API доступны в чате справа
	instantiationService.invokeFunction(accessor => {
		const languageModels = accessor.get(ILanguageModelsService);
		const keysService = accessor.get(IAuraApiKeysService);
		const configurationService = accessor.get(IConfigurationService);
		const storageService = accessor.get(IStorageService);
		// Вендор обязателен: registerLanguageModelProvider бросает "UNKNOWN vendor",
		// если дескриптор не зарегистрирован — без этого чат на своих ключах не поднимался.
		languageModels.deltaLanguageModelChatProviderDescriptors([{
			vendor: AURA_API_VENDOR,
			displayName: 'Aura API',
			configuration: undefined,
			managementCommand: AURA_API_OPEN_COMMAND_ID,
			when: undefined,
		}], []);
		languageModels.registerLanguageModelProvider(
			AURA_API_VENDOR,
			new AuraApiChatProvider(keysService, configurationService, storageService)
		);
		// Участник чата по умолчанию: без него панель не знает, кому отправлять запрос,
		// и в Code – OSS без Copilot чат просто молчит.
		try {
			registerAuraApiChatAgent(instantiationService, accessor.get(IChatAgentService));
			accessor.get(ILogService).info('[AuraAPI] чат-агент Aura зарегистрирован как участник по умолчанию');
		} catch (e) {
			// Регистрация падает, например, при дублировании id. Молчать нельзя:
			// внешне это выглядит как «чат отвечает ошибкой Copilot без причины».
			accessor.get(ILogService).error('[AuraAPI] не удалось зарегистрировать чат-агента', e);
		}
	});
}

/**
 * Плагин активируется только если он установлен через Aura Market.
 * После установки маркет предлагает перезагрузить окно — и плагин регистрируется.
 */
class AuraApiPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.auraApiPlugin';

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		if (storageService.get(auraMarketInstalledKey('aura-api'), StorageScope.APPLICATION, 'false') === 'true') {
			registerAuraApiPlugin(instantiationService);
		}
	}
}

registerWorkbenchContribution2(AuraApiPluginContribution.ID, AuraApiPluginContribution, WorkbenchPhase.AfterRestored);

// Настройка: системные правила/промпт для моделей Aura API в чате
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'auraApi',
	title: localize('auraApi.config', "Aura API"),
	properties: {
		[AURA_API_SYSTEM_PROMPT_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('auraApi.chat.systemPrompt', "Системные правила для моделей Aura API: как модель должна себя вести в чате (стиль, ограничения, соглашения проекта). Добавляется первым системным сообщением к каждому запросу. Дополнительно подхватывается файл `.aura/rules.md` из корня проекта."),
		},
		[AURA_API_DAILY_BUDGET_SETTING]: {
			type: 'number',
			default: 0,
			minimum: 0,
			markdownDescription: localize('auraApi.chat.dailyBudgetUsd', "Дневной лимит расхода на один ключ в долларах (0 — без лимита). Расход считается по usage из ответов провайдера и прайс-таблице; при достижении лимита ключ исключается из чата до следующих суток."),
		},
	},
});
