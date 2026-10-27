// Capability: config injection.
//
// Mod layout: config/**/*.<type> (npc, obj, loc, seq, ...), same syntax as
// base content configs. A new [name] gets a stable id after base content; a
// [name] that exists in base content replaces that config entirely. When two
// mods define the same name, the later mod in load order wins (warning).

import fs from 'fs';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { printInfo } from '#/util/Logger.js';
import type { PackFile } from '#tools/pack/PackFileBase.js';
import { EnumPack, HuntPack, IdkPack, InvPack, LocPack, MesAnimPack, NpcPack, ObjPack, ParamPack, SeqPack, SpotAnimPack, StructPack, VarnPack, VarpPack, VarsPack } from '#tools/pack/PackFile.js';
import { parseConfigLines, splitConfigLines } from '#tools/pack/config/PackShared.js';

// extension ('.npc') -> PackFile holding that type's names/ids
const configTypes: Map<string, PackFile> = new Map();

// Make a config type injectable from mods. The type must already be packed
// through readConfigs (tools/pack/config/PackShared.ts); its symbols must come
// from the in-memory PackFile (see tools/pack/CompilerSymbols.ts) for scripts
// to reference new names. The idmap kind is the extension without the dot.
export function registerConfigType(extension: string, pack: PackFile) {
    configTypes.set(extension, pack);
}

export function isConfigTypeInjectable(extension: string): boolean {
    return configTypes.has(extension);
}

registerConfigType('.npc', NpcPack);
registerConfigType('.obj', ObjPack);
registerConfigType('.loc', LocPack);
registerConfigType('.seq', SeqPack);
registerConfigType('.spotanim', SpotAnimPack);
registerConfigType('.idk', IdkPack);
registerConfigType('.enum', EnumPack);
registerConfigType('.struct', StructPack);
registerConfigType('.hunt', HuntPack);
registerConfigType('.mesanim', MesAnimPack);
registerConfigType('.varp', VarpPack);
registerConfigType('.varn', VarnPack);
registerConfigType('.vars', VarsPack);
registerConfigType('.param', ParamPack);
registerConfigType('.inv', InvPack);

function modConfigFiles(extension?: string): ModFile[] {
    return ModManager.listFiles('config', extension ?? [...configTypes.keys()]);
}

// [name] headers of a mod config file, with 1-based line numbers. Uses the
// same header rules as parseConfigLines (a line starting with '[').
function scanHeaders(file: ModFile): { name: string; line: number }[] {
    const headers: { name: string; line: number }[] = [];
    const lines = splitConfigLines(fs.readFileSync(file.path, 'utf-8'));
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('[')) {
            continue;
        }
        if (!line.endsWith(']')) {
            throw ModManager.error(file, i + 1, `Missing closing bracket: ${line}`);
        }
        const name = line.substring(1, line.length - 1);
        if (!name.length) {
            throw ModManager.error(file, i + 1, 'No config name');
        }
        headers.push({ name, line: i + 1 });
    }
    return headers;
}

const capability: ModCapability = {
    name: 'configs',

    // Register every mod config name on every build (even when the type is
    // not repacked) so ids and compiler symbols are always complete. Also
    // rejects a name defined twice by the same mod.
    afterRevalidate() {
        // kind:name -> where this mod first defined it
        const defined = new Map<string, { file: ModFile; line: number }>();

        for (const file of modConfigFiles()) {
            const kind = file.ext.slice(1);
            const pack = configTypes.get(file.ext)!;

            for (const { name, line } of scanHeaders(file)) {
                const key = `${kind}:${name}`;
                const first = defined.get(key);
                if (first && first.file.mod === file.mod) {
                    throw ModManager.error(file, line, `Duplicate config found: ${name} (also defined at ${first.file.relPath}:${first.line})`);
                }
                defined.set(key, { file, line });

                ModManager.claim(kind, name, file);
                ModManager.registerName(kind, pack, name);
            }
        }
    },

    // Parse with the base parser and rules (parseConfigLines), then add or
    // replace entries. Later mods in load order replace earlier ones.
    configs(_ctx, { extension, configs, parse, requiredProperties }) {
        const pack = configTypes.get(extension);
        if (!pack) {
            return;
        }

        const files = modConfigFiles(extension);
        if (files.length > 0) {
            ModManager.markTouched(extension);
        }

        for (const file of files) {
            parseConfigLines(splitConfigLines(fs.readFileSync(file.path, 'utf-8')), parse, requiredProperties, {
                error: (line, message) => ModManager.error(file, line, message),
                onConfig: (debugname, config) => {
                    if (ModManager.isBaseName(pack, debugname)) {
                        printInfo(`[mods] ${file.mod.name} replaces base ${extension} [${debugname}]`);
                    }
                    configs.set(debugname, config);
                }
            });
        }
    }
};

export default capability;
