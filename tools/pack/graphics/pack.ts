import fs from 'fs';
import path from 'path';

import { compressGz } from '#/io/GZip.js';
import Environment from '#/util/Environment.js';
import FileStream from '#/io/FileStream.js';
import { listFilesExt } from '#tools/pack/Parse.js';
import { AnimSetPack, ModelPack } from '#tools/pack/PackFile.js';
import { printWarning } from '#/util/Logger.js';
import ModManager from '#/mod/ModManager.js';

export function packClientModel(cache: FileStream, modelFlags: number[]) {
    // model name -> source file. Mod models (src/mod/capabilities/models.ts)
    // replace base models of the same name and add new ones.
    const sources = new Map<string, string>();
    for (const file of listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.ob2')) {
        const basename = path.basename(file);
        sources.set(basename.substring(0, basename.lastIndexOf('.')), file);
    }
    for (const [name, file] of ModManager.getAssets('model')) {
        sources.set(name, file);
    }

    for (const [name, file] of sources) {
        const id = ModelPack.getByName(name);
        const data = fs.readFileSync(file);
        if (data.length) {
            cache.write(1, id, compressGz(data)!, 1);
        }
    }

    for (let id = 0; id < ModelPack.max; id++) {
        if (!cache.has(1, id)) {
            if (modelFlags[id] > 0) {
                printWarning(`missing model ${ModelPack.getById(id)} (${id})`);
            } else {
                // printDebug(`missing model ${ModelPack.getById(id)} (${id})`);
            }
        }
    }

    // animset name -> source file. Mod animsets (src/mod/capabilities/anims.ts)
    // replace base sets of the same name and add new ones.
    const anims = new Map<string, string>();
    for (const file of listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.anim')) {
        const basename = path.basename(file);
        anims.set(basename.substring(0, basename.lastIndexOf('.')), file);
    }
    for (const [name, file] of ModManager.getAssets('animset')) {
        anims.set(name, file);
    }

    for (const [name, file] of anims) {
        const id = AnimSetPack.getByName(name);
        const data = fs.readFileSync(file);
        if (data.length) {
            cache.write(2, id, compressGz(data)!, 1);
        }
    }
}
