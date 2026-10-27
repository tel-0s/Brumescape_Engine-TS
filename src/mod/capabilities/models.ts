// Capability: custom models.
//
// Mod layout: models/**/<name>.ob2. A new name gets a stable model id after
// base content; configs reference it by name (model=<name>). A name that
// exists in base content replaces that model. When two mods ship the same
// name, the later mod in load order wins (warning). The same name twice in one
// mod is an error.
//
// The model packer (tools/pack/graphics/pack.ts) writes every
// ModManager.getAssets('model') entry over the base model of the same name.

import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';
import { printInfo } from '#/util/Logger.js';
import { ModelPack } from '#tools/pack/PackFile.js';

const capability: ModCapability = {
    name: 'models',

    // Register names before configs resolve model names to ids and before
    // modelFlags is sized to ModelPack.max.
    afterRevalidate() {
        for (const file of ModManager.listFiles('models', '.ob2')) {
            const previous = ModManager.claim('model', file.name, file);
            if (previous && previous.mod === file.mod) {
                throw ModManager.error(file, null, `model ${file.name} is also defined by ${previous.relPath}`);
            }
            if (ModManager.isBaseName(ModelPack, file.name)) {
                printInfo(`[mods] ${file.mod.name} replaces base model ${file.name}`);
            }
            ModManager.registerName('model', ModelPack, file.name);
            ModManager.setAsset('model', file.name, file.path);
        }
    }
};

export default capability;
