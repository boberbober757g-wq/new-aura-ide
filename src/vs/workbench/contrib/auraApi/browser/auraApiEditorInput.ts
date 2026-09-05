/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Aura API — центральная вкладка менеджера ключей (EditorInput). */

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export class AuraApiEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.auraApi';
	static readonly RESOURCE = URI.from({ scheme: 'aura-api', path: 'manager' });

	override get typeId(): string { return AuraApiEditorInput.ID; }
	override get editorId(): string { return this.typeId; }
	override get resource(): URI { return AuraApiEditorInput.RESOURCE; }

	override getName(): string { return 'Aura API'; }
	override getIcon() { return undefined; }

	override matches(other: unknown): boolean {
		return other instanceof AuraApiEditorInput;
	}
}

export class AuraApiEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(instantiationService: IInstantiationService): AuraApiEditorInput {
		return instantiationService.createInstance(AuraApiEditorInput);
	}
}
