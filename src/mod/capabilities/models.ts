// Capability: custom models.
//
// Mod layout: models/**/<name>.ob2. A new name gets a stable model id after
// base content; configs reference it by name (model=<name>). A name that
// exists in base content replaces that model. When two mods ship the same
// name, the later mod in load order wins (warning).

import fs from 'fs';

import { compressGz } from '#/io/GZip.js';
import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { printInfo } from '#/util/Logger.js';
import { ModelPack } from '#tools/pack/PackFile.js';

// model name -> winning mod file (filled by afterRevalidate)
const sources: Map<string, ModFile> = new Map();

const capability: ModCapability = {
    name: 'models',

    // Register names before configs resolve model names to ids and before
    // modelFlags is sized to ModelPack.max.
    afterRevalidate() {
        sources.clear();
        for (const file of ModManager.listFiles('models', '.ob2')) {
            ModManager.claim('model', file.name, file);
            ModManager.registerName('model', ModelPack, file.name);
            sources.set(file.name, file);
        }
    },

    before: {
        // Write into cache archive 1 at the registered id. The versionlist
        // stage picks them up since it loops 0..ModelPack.max.
        models(ctx) {
            for (const [name, file] of sources) {
                const data = fs.readFileSync(file.path);
                if (!data.length) {
                    continue;
                }
                if (ModManager.isBaseName(ModelPack, name)) {
                    printInfo(`[mods] ${file.mod.name} replaces base model ${name}`);
                }
                ctx.cache!.write(1, ModelPack.getByName(name), compressGz(data)!, 1);
            }
        }
    }
};

export default capability;
