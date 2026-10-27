// Capability: config injection and partial config patches.
//
// Mod layout:
//   config/**/*.<type>        (npc, obj, loc, seq, ...) same syntax as base
//                             content configs. A new [name] gets a stable id
//                             after base content; a [name] that exists in
//                             base content replaces that config entirely.
//   config/patch/**/*.<type>  partial patches: change some properties of a
//                             config that base content or an earlier mod
//                             defines (see src/mod/ConfigPatch.ts).
// Mods apply in load order, each mod's full configs before its patches. When
// two mods define the same name, the later mod in load order wins (warning).

import fs from 'fs';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { PatchError, applyPatch, parsePatch } from '#/mod/ConfigPatch.js';
import type { PatchBlock } from '#/mod/ConfigPatch.js';
import { printInfo, printWarning } from '#/util/Logger.js';
import type { PackFile } from '#tools/pack/PackFileBase.js';
import { EnumPack, HuntPack, IdkPack, InvPack, LocPack, MesAnimPack, NpcPack, ObjPack, ParamPack, SeqPack, SpotAnimPack, StructPack, VarnPack, VarpPack, VarsPack } from '#tools/pack/PackFile.js';
import { parseConfigLines, splitConfigLines } from '#tools/pack/config/PackShared.js';

// extension ('.npc') -> PackFile holding that type's names/ids
const configTypes: Map<string, PackFile> = new Map();

// Make a config type injectable from mods. The type must already be packed
// through readConfigs (tools/pack/config/PackShared.ts); its symbols must come
// from the in-memory PackFile (see tools/pack/CompilerSymbols.ts) for scripts
// to reference new names. The idmap kind is the extension without the dot.
// Patches (config/patch/) work for every registered type.
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

// config/patch/ holds patches, everything else under config/ holds full configs
const PATCH_DIR = 'patch/';

function isPatchFile(file: ModFile): boolean {
    return file.subPath.startsWith(PATCH_DIR);
}

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

function readPatch(file: ModFile, parse: Parameters<typeof parsePatch>[1]): PatchBlock[] {
    try {
        return parsePatch(splitConfigLines(fs.readFileSync(file.path, 'utf-8')), parse);
    } catch (err) {
        if (err instanceof PatchError) {
            throw ModManager.error(file, err.line, err.message);
        }
        throw err;
    }
}

const capability: ModCapability = {
    name: 'configs',

    // Register every mod config name on every build (even when the type is
    // not repacked) so ids and compiler symbols are always complete. Also
    // rejects a name defined twice by the same mod, and a patch of a name that
    // no earlier mod or base content defines.
    afterRevalidate() {
        // kind:name -> where this mod first defined it
        const defined = new Map<string, { file: ModFile; line: number }>();
        const files = modConfigFiles();

        for (const mod of ModManager.mods) {
            const own = files.filter(f => f.mod === mod);

            for (const file of own.filter(f => !isPatchFile(f))) {
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

            // patches: the name must already exist (base content, an earlier
            // mod, or this mod's own config/)
            const patched = new Map<string, { file: ModFile; line: number }>();
            for (const file of own.filter(isPatchFile)) {
                const pack = configTypes.get(file.ext)!;
                for (const { name, line } of scanHeaders(file)) {
                    const key = `${file.ext}:${name}`;
                    const first = patched.get(key);
                    if (first) {
                        throw ModManager.error(file, line, `[${name}] is already patched by this mod (${first.file.relPath}:${first.line}); use one block`);
                    }
                    patched.set(key, { file, line });
                    if (pack.getByName(name) === -1) {
                        throw ModManager.error(file, line, `${file.ext} [${name}] does not exist in base content or an earlier mod. A patch can only change an existing config; define new configs outside config/patch/`);
                    }
                }
            }
        }
    },

    // Parse with the base parser and rules (parseConfigLines), then add or
    // replace entries, then apply patches. Mod by mod, in load order.
    configs(_ctx, { extension, configs, parse, requiredProperties }) {
        const pack = configTypes.get(extension);
        if (!pack) {
            return;
        }

        const files = modConfigFiles(extension);
        if (files.length > 0) {
            ModManager.markTouched(extension);
        }

        // name -> the mod whose patch last changed it
        const patchedBy = new Map<string, string>();

        for (const mod of ModManager.mods) {
            const own = files.filter(f => f.mod === mod);

            for (const file of own.filter(f => !isPatchFile(f))) {
                parseConfigLines(splitConfigLines(fs.readFileSync(file.path, 'utf-8')), parse, requiredProperties, {
                    error: (line, message) => ModManager.error(file, line, message),
                    onConfig: (debugname, config) => {
                        if (ModManager.isBaseName(pack, debugname)) {
                            printInfo(`[mods] ${file.mod.name} replaces base ${extension} [${debugname}]`);
                        }
                        const patcher = patchedBy.get(debugname);
                        if (patcher) {
                            printWarning(`[mods] ${file.mod.name} replaces ${extension} [${debugname}] entirely; the patch from ${patcher} no longer applies`);
                            patchedBy.delete(debugname);
                        }
                        configs.set(debugname, config);
                    }
                });
            }

            for (const file of own.filter(isPatchFile)) {
                for (const block of readPatch(file, parse)) {
                    const config = configs.get(block.name);
                    if (!config) {
                        throw ModManager.error(file, block.line, `${extension} [${block.name}] does not exist in base content or an earlier mod`);
                    }

                    let result;
                    try {
                        result = applyPatch(extension, config, block);
                    } catch (err) {
                        if (err instanceof PatchError) {
                            throw ModManager.error(file, err.line, err.message);
                        }
                        throw err;
                    }
                    for (const warning of result.warnings) {
                        ModManager.warn(file, warning.line, warning.message);
                    }

                    for (const required of requiredProperties) {
                        if (!config.some(l => l.key === required)) {
                            throw ModManager.error(file, block.line, `[${block.name}] is missing the required property ${required} after this patch`);
                        }
                    }

                    const owner = ModManager.isBaseName(pack, block.name) ? 'base' : 'mod';
                    printInfo(`[mods] ${mod.name} patches ${owner} ${extension} [${block.name}]: ${result.summary.join(', ') || '(no changes)'}`);
                    patchedBy.set(block.name, mod.name);
                }
            }
        }
    }
};

export default capability;
