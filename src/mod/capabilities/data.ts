// Capability: data types (constants, database tables, floors, categories).
//
// Mod layout (all under config/, any subfolders):
//   config/**/*.constant   constants (^name = value) for scripts and configs
//   config/**/*.dbtable    new database tables; a table with a base name replaces it
//   config/**/*.dbrow      new rows; a row with a base name replaces it; rows may
//                          belong to base tables (e.g. musicregion)
//   config/**/*.flo        floor types (underlays and overlays), ids go to the client
//   category=<name> in a mod .npc/.obj/.loc declares the category <name>
//
// .dbtable, .dbrow and .flo go through the generic config injection in
// configs.ts (names registered in afterRevalidate, parsed with the base parser).
// This module registers those types, validates floors, and adds constants and
// categories, which configs.ts does not know about.

import fs from 'fs';

import ModManager from '#/mod/ModManager.js';
import { registerConfigType } from '#/mod/capabilities/configs.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { printInfo } from '#/util/Logger.js';
import { CategoryPack, DbRowPack, DbTablePack, FloPack } from '#tools/pack/PackFile.js';
import { splitConfigLines } from '#tools/pack/config/PackShared.js';
import type { ConfigLine } from '#tools/pack/config/PackShared.js';

registerConfigType('.dbtable', DbTablePack);
registerConfigType('.dbrow', DbRowPack);
registerConfigType('.flo', FloPack);

// Map file limits (see tools/pack/map/Pack.js): an overlay is written as a
// byte holding (flo id + 1); an underlay is the opcode (flo id + 1) + 81.
const MAX_OVERLAY_FLO_ID = 254;
const MAX_UNDERLAY_FLO_ID = 173;
// The floor texture is one byte in flo.dat
const MAX_FLO_TEXTURE = 255;

// ---------------------------------------------------------------------------
// constants

interface ModConstant {
    name: string;
    value: string;
    override: boolean;
    file: ModFile;
    line: number;
}

// Constants of the current build, after conflict resolution, in definition order
let resolved: Map<string, ModConstant> = new Map();
let parsed: ModConstant[] = [];
// The base constant names that mods replaced (for BUILD_VERIFY bookkeeping)
let replacedBase = false;

const CONSTANT_NAME = /^[a-z0-9_]+$/;

function parseConstantFile(file: ModFile): ModConstant[] {
    const out: ModConstant[] = [];
    const lines = splitConfigLines(fs.readFileSync(file.path, 'utf-8'));
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line || line.startsWith('//')) {
            continue;
        }

        let override = false;
        if (line.startsWith('override ')) {
            override = true;
            line = line.substring('override '.length).trim();
        }

        const parts = line.split('=');
        if (parts.length !== 2) {
            throw ModManager.error(file, i + 1, `Bad constant declaration (expected '^name = value'): ${lines[i].trim()}`);
        }

        let name = parts[0].trim();
        if (name.startsWith('^')) {
            name = name.substring(1);
        }
        const value = parts[1].trim();
        if (!CONSTANT_NAME.test(name)) {
            throw ModManager.error(file, i + 1, `Invalid constant name '${name}' (use lowercase letters, digits and underscores)`);
        }
        if (!value.length) {
            throw ModManager.error(file, i + 1, `Constant '${name}' has no value`);
        }

        out.push({ name, value, override, file, line: i + 1 });
    }
    return out;
}

// ---------------------------------------------------------------------------
// categories

const CATEGORY_TYPES = ['.npc', '.obj', '.loc'];

// ---------------------------------------------------------------------------
// floors

const floFiles: Map<string, ModFile> = new Map();

function scanHeaders(file: ModFile): string[] {
    const names: string[] = [];
    for (const line of splitConfigLines(fs.readFileSync(file.path, 'utf-8'))) {
        if (line.startsWith('[') && line.endsWith(']')) {
            names.push(line.substring(1, line.length - 1));
        }
    }
    return names;
}

function lineValue(config: ConfigLine[] | undefined, key: string): unknown {
    return config?.find(l => l.key === key)?.value;
}

const capability: ModCapability = {
    name: 'data',

    prepare() {
        parsed = [];
        resolved = new Map();
        replacedBase = false;

        const seen = new Map<string, ModConstant>();
        for (const file of ModManager.listFiles('config', '.constant')) {
            for (const constant of parseConstantFile(file)) {
                const previous = seen.get(constant.name);
                if (previous && previous.file.mod === file.mod) {
                    throw ModManager.error(file, constant.line, `Duplicate constant found: ${constant.name} (also defined at ${previous.file.relPath}:${previous.line})`);
                }
                seen.set(constant.name, constant);
                parsed.push(constant);
            }
        }
    },

    afterRevalidate() {
        // categories used by mod configs: ids continue after the base ones
        for (const file of ModManager.listFiles('config', CATEGORY_TYPES)) {
            const lines = splitConfigLines(fs.readFileSync(file.path, 'utf-8'));
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('category=')) {
                    continue;
                }
                const name = lines[i].substring('category='.length);
                if (!name.length) {
                    throw ModManager.error(file, i + 1, 'Empty category name');
                }
                ModManager.registerName('category', CategoryPack, name);
            }
        }

        floFiles.clear();
        for (const file of ModManager.listFiles('config', '.flo')) {
            for (const name of scanHeaders(file)) {
                floFiles.set(name, file);
            }
        }
    },

    // Runs inside packConfigs: base constants are loaded, no config is parsed yet
    constants(_ctx, constants) {
        // base constants are exactly the ones present now; names added below
        // by earlier mods are tracked separately
        const modOwned = new Map<string, ModConstant>();
        for (const constant of parsed) {
            const { name, value, file, line } = constant;
            const earlier = modOwned.get(name);
            const isBase = constants.has(name) && !earlier;

            if (constants.has(name) && !constant.override) {
                const where = isBase ? 'base content' : `mod ${earlier!.file.mod.name} (${earlier!.file.relPath}:${earlier!.line})`;
                throw ModManager.error(file, line, `Constant '${name}' is already defined by ${where}. Write 'override ^${name} = ...' to replace it on purpose.`);
            }
            if (constant.override && !constants.has(name)) {
                throw ModManager.error(file, line, `'override' used but no base content or earlier mod defines constant '${name}'`);
            }

            if (isBase) {
                printInfo(`[mods] ${file.mod.name} replaces base constant ^${name}`);
                replacedBase = true;
            } else if (earlier) {
                ModManager.claim('constant', name, file);
            }

            constants.set(name, value);
            modOwned.set(name, constant);
            resolved.set(name, constant);
        }

        if (replacedBase) {
            // base configs and scripts that use the constant now pack differently
            for (const ext of ['.npc', '.obj', '.loc', '.seq', '.spotanim', '.idk', '.enum', '.struct', '.hunt', '.mesanim', '.varp', '.varn', '.vars', '.param', '.inv', '.dbtable', '.dbrow', '.flo']) {
                ModManager.markTouched(ext);
            }
        }
    },

    // Mod-only checks of the packed floors, after configs.ts injected them
    configs(_ctx, { extension, configs }) {
        if (extension !== '.flo') {
            return;
        }

        for (const [name, file] of floFiles) {
            const config = configs.get(name);
            const id = FloPack.getByName(name);
            if (!config || id === -1) {
                continue;
            }

            const texture = lineValue(config, 'texture');
            if (typeof texture === 'number' && texture > MAX_FLO_TEXTURE) {
                throw ModManager.error(file, null, `Floor '${name}' uses texture id ${texture}; flo.dat stores the texture in one byte (max ${MAX_FLO_TEXTURE})`);
            }

            if (ModManager.isBaseName(FloPack, name)) {
                continue;
            }

            const overlay = lineValue(config, 'overlay') === true;
            const limit = overlay ? MAX_OVERLAY_FLO_ID : MAX_UNDERLAY_FLO_ID;
            if (id > limit) {
                throw ModManager.error(file, null, `Floor '${name}' got flo id ${id}, but a map can only reference ${overlay ? 'overlay' : 'underlay'} floors up to id ${limit}. Remove unused floors from mods, or make it an overlay (overlay=yes).`);
            }
            printInfo(`[mods] floor ${name}: flo id ${id}; in a .jm2 map write ${overlay ? 'o' : 'u'}${id + 1}`);
        }
    },

    // constant.sym is written from base content only; add the mod constants
    afterSymbols() {
        if (resolved.size === 0) {
            return;
        }

        const path = 'data/symbols/constant.sym';
        const entries = new Map<string, string>();
        for (const line of fs.existsSync(path) ? fs.readFileSync(path, 'utf-8').split('\n') : []) {
            const tab = line.indexOf('\t');
            if (tab !== -1) {
                entries.set(line.substring(0, tab), line.substring(tab + 1));
            }
        }

        for (const [name, constant] of resolved) {
            let value = constant.value;
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1);
            }
            entries.set(name, value);
        }

        let out = '';
        for (const [name, value] of entries) {
            out += `${name}\t${value}\n`;
        }
        fs.writeFileSync(path, out);
    }
};

export default capability;
