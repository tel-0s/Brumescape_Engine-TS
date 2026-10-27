import fs from 'fs';
import path from 'path';

import { printInfo, printError } from '#/util/Logger.js';
import { EnumPack, HuntPack, IdkPack, InvPack, LocPack, MesAnimPack, ModelPack, NpcPack, ObjPack, ParamPack, SeqPack, SpotAnimPack, StructPack, TexturePack, VarnPack, VarpPack, VarsPack } from '#tools/pack/PackFile.js';
import type { PackFile } from '#tools/pack/PackFileBase.js';
import { parseEnumConfig } from '#tools/pack/config/EnumConfig.js';
import { parseHuntConfig } from '#tools/pack/config/HuntConfig.js';
import { parseIdkConfig } from '#tools/pack/config/IdkConfig.js';
import { parseInvConfig } from '#tools/pack/config/InvConfig.js';
import { parseLocConfig } from '#tools/pack/config/LocConfig.js';
import { parseMesAnimConfig } from '#tools/pack/config/MesAnimConfig.js';
import { parseNpcConfig } from '#tools/pack/config/NpcConfig.js';
import { parseObjConfig } from '#tools/pack/config/ObjConfig.js';
import { parseParamConfig } from '#tools/pack/config/ParamConfig.js';
import { parseSeqConfig } from '#tools/pack/config/SeqConfig.js';
import { parseSpotAnimConfig } from '#tools/pack/config/SpotAnimConfig.js';
import { parseStructConfig } from '#tools/pack/config/StructConfig.js';
import { parseVarnConfig } from '#tools/pack/config/VarnConfig.js';
import { parseVarpConfig } from '#tools/pack/config/VarpConfig.js';
import { parseVarsConfig } from '#tools/pack/config/VarsConfig.js';
import { ConfigLine, ConfigParseCallback } from '#tools/pack/config/PackShared.js';

// Config types a mod may inject via config/<name>.<ext>. Resolved lazily (not
// in a module-level const) to stay safe against the import cycle between
// ModManager, the config parsers, and PackShared.
function injectableType(extension: string): { pack: PackFile; parse: ConfigParseCallback } | null {
    switch (extension) {
        case '.npc':
            return { pack: NpcPack, parse: parseNpcConfig };
        case '.obj':
            return { pack: ObjPack, parse: parseObjConfig };
        case '.loc':
            return { pack: LocPack, parse: parseLocConfig };
        case '.seq':
            return { pack: SeqPack, parse: parseSeqConfig };
        case '.spotanim':
            return { pack: SpotAnimPack, parse: parseSpotAnimConfig };
        case '.idk':
            return { pack: IdkPack, parse: parseIdkConfig };
        case '.enum':
            return { pack: EnumPack, parse: parseEnumConfig };
        case '.struct':
            return { pack: StructPack, parse: parseStructConfig };
        case '.hunt':
            return { pack: HuntPack, parse: parseHuntConfig };
        case '.mesanim':
            return { pack: MesAnimPack, parse: parseMesAnimConfig };
        case '.varp':
            return { pack: VarpPack, parse: parseVarpConfig };
        case '.varn':
            return { pack: VarnPack, parse: parseVarnConfig };
        case '.vars':
            return { pack: VarsPack, parse: parseVarsConfig };
        case '.param':
            return { pack: ParamPack, parse: parseParamConfig };
        case '.inv':
            return { pack: InvPack, parse: parseInvConfig };
        default:
            return null;
    }
}

// Persistent mod ID allocation. Mod-injected config entries get stable IDs
// recorded in mods/idmap.json so they survive rebuilds and adding/removing other
// mods (keeping saved player data valid). IDs are assigned contiguously right
// after base content — NOT in a high reserved range — because the engine packs
// configs densely AND several systems are sized to the config count (e.g.
// Player.save writes every varp into a fixed buffer; the client allocates
// id-indexed arrays). A high id would inflate those counts and overflow them.
interface IdMapEntry {
    next: number;
    ids: Record<string, number>;
}

export interface ModConfig {
    name: string;
    version: string;
    author: string;
    description?: string;
    dependencies?: Record<string, string>;
    // Optional [proc,<name>] run once on world boot to place content in the world
    init?: string;
}

export class Mod {
    path: string;
    config: ModConfig;
    
    constructor(dir: string, config: ModConfig) {
        this.path = dir;
        this.config = config;
    }

    async load() {
        // Check for config overrides (npc, obj, loc, ...)
        const configDir = path.join(this.path, 'config');
        if (fs.existsSync(configDir)) {
            for (const file of fs.readdirSync(configDir)) {
                if (injectableType(path.extname(file)) !== null) {
                    this.configFiles.push(path.join(configDir, file));
                }
            }
        }

        // Check for custom models (.ob2)
        const modelDir = path.join(this.path, 'models');
        if (fs.existsSync(modelDir)) {
            for (const file of fs.readdirSync(modelDir)) {
                if (file.endsWith('.ob2')) {
                    this.modelFiles.push(path.join(modelDir, file));
                }
            }
        }

        // Check for custom textures (.png)
        const textureDir = path.join(this.path, 'textures');
        if (fs.existsSync(textureDir)) {
            for (const file of fs.readdirSync(textureDir)) {
                if (file.endsWith('.png')) {
                    this.textureFiles.push(path.join(textureDir, file));
                }
            }
        }

        // Check for scripts
        const scriptDir = path.join(this.path, 'scripts');
        if (fs.existsSync(scriptDir)) {
            // We need to tell the system to include these scripts
            this.scriptPath = scriptDir;
        }
    }

    // Absolute paths of injectable config files found in this mod's config/ dir
    configFiles: string[] = [];
    // Absolute paths of custom .ob2 model files in this mod's models/ dir
    modelFiles: string[] = [];
    // Absolute paths of custom .png texture files in this mod's textures/ dir
    textureFiles: string[] = [];
    scriptPath: string | null = null;
}

class ModManager {
    mods: Mod[] = [];
    modsDir: string = 'mods';
    
    // Persisted name -> id assignments per config type (mods/idmap.json)
    idMap: Record<string, IdMapEntry> | null = null;
    idMapDirty = false;

    // Custom texture name -> directory holding its <name>.png (for the packer)
    modTextureDirs: Map<string, string> = new Map();

    get idMapPath(): string {
        return path.join(this.modsDir, 'idmap.json');
    }

    async init() {
        if (!fs.existsSync(this.modsDir)) {
            fs.mkdirSync(this.modsDir);
        }
        await this.loadMods();
    }

    async loadMods() {
        if (!fs.existsSync(this.modsDir)) return;
        // Reset first so repeated loads (e.g. on ::rebuild, which re-runs
        // ModManager.init) replace the list instead of appending duplicates.
        this.mods = [];
        const entries = fs.readdirSync(this.modsDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const modPath = path.join(this.modsDir, entry.name);
                const configPath = path.join(modPath, 'mod.json');

                if (fs.existsSync(configPath)) {
                    try {
                        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ModConfig;
                        const mod = new Mod(modPath, config);
                        await mod.load();
                        this.mods.push(mod);
                        printInfo(`Loaded mod: ${config.name} v${config.version}`);
                    } catch (err) {
                        printError(`Failed to load mod at ${modPath}: ${err}`);
                    }
                }
            }
        }
    }

    loadIdMap() {
        if (this.idMap) return;
        if (fs.existsSync(this.idMapPath)) {
            this.idMap = JSON.parse(fs.readFileSync(this.idMapPath, 'utf-8')) as Record<string, IdMapEntry>;
        } else {
            this.idMap = {};
        }
    }

    saveIdMap() {
        if (!this.idMap || !this.idMapDirty) return;
        fs.writeFileSync(this.idMapPath, JSON.stringify(this.idMap, null, 4) + '\n');
        this.idMapDirty = false;
    }

    // Assign a stable ID to a newly-injected config entry, reusing the persisted
    // ID when present. Guards against an ID already claimed by base content.
    assignId(extension: string, pack: PackFile, name: string): number {
        this.loadIdMap();
        const key = extension.slice(1); // '.npc' -> 'npc'

        let entry = this.idMap![key];
        if (!entry) {
            entry = { next: 0, ids: {} };
            this.idMap![key] = entry;
            this.idMapDirty = true;
        }

        let id = entry.ids[name];
        const occupant = id !== undefined ? pack.pack.get(id) : undefined;
        if (id === undefined || (occupant !== undefined && occupant !== name)) {
            if (id !== undefined) {
                printError(`[ModManager] ${key} id ${id} (${name}) is already used by '${occupant}' (base content changed?). Reassigning.`);
            }
            // Assign contiguously, right after base content / prior mod entries
            id = Math.max(pack.max, entry.next);
            entry.ids[name] = id;
            this.idMapDirty = true;
        }
        if (id + 1 > entry.next) {
            entry.next = id + 1;
            this.idMapDirty = true;
        }
        return id;
    }

    // Hook into config packing to inject mod-provided configs of a given type.
    // Mirrors the parse loop in readConfigs (PackShared) but registers any new
    // names into the in-memory Pack so they receive an ID and flow through both
    // packing and symbol generation. No-op for non-injectable types or when no
    // mod provides that type.
    async injectConfigs(extension: string, configs: Map<string, ConfigLine[]>) {
        const type = injectableType(extension);
        if (!type) {
            return;
        }

        if (this.mods.length === 0) {
            // Ensure mods are loaded if injection runs before init()
            if (!fs.existsSync(this.modsDir)) return;
            await this.loadMods();
        }

        for (const mod of this.mods) {
            for (const file of mod.configFiles) {
                if (path.extname(file) !== extension) {
                    continue;
                }

                const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);

                let debugname: string | null = null;
                let config: ConfigLine[] = [];

                const flush = () => {
                    if (debugname === null) {
                        return;
                    }

                    configs.set(debugname, config);

                    // nameToId is the authoritative id<->name map (register()
                    // updates it; the names Set is not), so use it to tell a
                    // brand-new entry apart from an override of base content.
                    if (!type.pack.nameToId.has(debugname)) {
                        const id = this.assignId(extension, type.pack, debugname);
                        type.pack.register(id, debugname);
                        // Dense packers loop 0..Pack.max, so max must cover a high id
                        if (id + 1 > type.pack.max) {
                            type.pack.max = id + 1;
                        }
                        printInfo(`[ModManager] Registered ${extension} ${debugname} (ID: ${id})`);
                    } else {
                        printInfo(`[ModManager] Overriding ${extension} ${debugname}`);
                    }
                };

                for (let line of lines) {
                    line = line.trim();
                    if (line.length === 0 || line.startsWith('//')) continue;

                    if (line.startsWith('[')) {
                        flush();
                        debugname = line.substring(1, line.length - 1);
                        config = [];
                        continue;
                    }

                    const separator = line.indexOf('=');
                    if (separator === -1) continue;

                    const key = line.substring(0, separator);
                    const value = line.substring(separator + 1);
                    const parsed = type.parse(key, value);
                    if (parsed !== null && parsed !== undefined) {
                        config.push({ key, value: parsed });
                    }
                }

                flush();
            }
        }

        this.saveIdMap();
    }

    // Register each mod's custom .ob2 model names into ModelPack with stable ids
    // (idmap key 'model'), so config model refs resolve and they get packed into
    // the cache + versionlist. Must run AFTER revalidatePack() (which resets the
    // Packs) and BEFORE configs are packed (which resolve model names to ids).
    async registerModModels() {
        if (this.mods.length === 0) {
            if (!fs.existsSync(this.modsDir)) return;
            await this.loadMods();
        }

        for (const mod of this.mods) {
            for (const file of mod.modelFiles) {
                const name = path.basename(file, path.extname(file));
                if (ModelPack.nameToId.has(name)) {
                    continue;
                }
                const id = this.assignId('.model', ModelPack, name);
                ModelPack.register(id, name);
                // Dense packers/versionlist loop 0..ModelPack.max
                if (id + 1 > ModelPack.max) {
                    ModelPack.max = id + 1;
                }
                printInfo(`[ModManager] Registered model ${name} (ID: ${id})`);
            }
        }

        this.saveIdMap();
    }

    // Register each mod's custom .png textures into TexturePack with stable ids
    // (idmap key 'texture', contiguous after the 50 base textures). Records the
    // source dir per name so packClientTexture can convertImage from the mod dir.
    // Must run after revalidatePack() and before packClientTexture().
    async registerModTextures() {
        if (this.mods.length === 0) {
            if (!fs.existsSync(this.modsDir)) return;
            await this.loadMods();
        }

        this.modTextureDirs.clear();

        for (const mod of this.mods) {
            for (const file of mod.textureFiles) {
                const name = path.basename(file, path.extname(file));
                this.modTextureDirs.set(name, path.dirname(file));
                if (TexturePack.nameToId.has(name)) {
                    continue;
                }
                const id = this.assignId('.texture', TexturePack, name);
                TexturePack.register(id, name);
                if (id + 1 > TexturePack.max) {
                    TexturePack.max = id + 1;
                }
                printInfo(`[ModManager] Registered texture ${name} (ID: ${id})`);
            }
        }

        this.saveIdMap();
    }
}

export default new ModManager();
