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
import type { ConfigLine } from '#tools/pack/config/PackShared.js';

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

// [name] headers defined in a mod config file
function scanNames(file: ModFile): string[] {
    const names: string[] = [];
    for (const raw of fs.readFileSync(file.path, 'utf-8').split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[') && line.endsWith(']')) {
            names.push(line.substring(1, line.length - 1));
        }
    }
    return names;
}

const capability: ModCapability = {
    name: 'configs',

    prepare() {
        // shouldBuild() only tracks base content, so it would skip a config
        // type that only a mod changed. Invalidate the packed server .dat of
        // every type a mod provides so it is repacked with the injection.
        for (const file of modConfigFiles()) {
            const dat = `data/pack/server/${file.ext.slice(1)}.dat`;
            if (fs.existsSync(dat)) {
                fs.rmSync(dat);
            }
        }
    },

    // Register every mod config name on every build (even when the type is
    // not repacked) so ids and compiler symbols are always complete.
    afterRevalidate() {
        for (const file of modConfigFiles()) {
            const pack = configTypes.get(file.ext)!;
            for (const name of scanNames(file)) {
                ModManager.claim(file.ext.slice(1), name, file);
                ModManager.registerName(file.ext.slice(1), pack, name);
            }
        }
    },

    configs(_ctx, { extension, configs, parse }) {
        const pack = configTypes.get(extension);
        if (!pack) {
            return;
        }

        for (const file of modConfigFiles(extension)) {
            const lines = fs.readFileSync(file.path, 'utf-8').split(/\r?\n/);

            let debugname: string | null = null;
            let config: ConfigLine[] = [];

            const flush = () => {
                if (debugname === null) {
                    return;
                }
                if (ModManager.isBaseName(pack, debugname)) {
                    printInfo(`[mods] ${file.mod.name} overrides base ${extension} ${debugname}`);
                }
                configs.set(debugname, config);
            };

            for (let line of lines) {
                line = line.trim();
                if (line.length === 0 || line.startsWith('//')) {
                    continue;
                }

                if (line.startsWith('[')) {
                    flush();
                    debugname = line.substring(1, line.length - 1);
                    config = [];
                    continue;
                }

                const separator = line.indexOf('=');
                if (separator === -1) {
                    continue;
                }

                const key = line.substring(0, separator);
                const value = line.substring(separator + 1);
                const parsed = parse(key, value);
                if (parsed !== null && parsed !== undefined) {
                    config.push({ key, value: parsed });
                }
            }

            flush();
        }
    }
};

export default capability;
