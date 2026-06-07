import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { printInfo, printError } from '#/util/Logger.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { convertImage } from '#tools/pack/PixPack.js';
import { EnumPack, HuntPack, IdkPack, InvPack, LocPack, MesAnimPack, NpcPack, ObjPack, ParamPack, SeqPack, SpotAnimPack, StructPack, VarnPack, VarpPack, VarsPack } from '#tools/pack/PackFile.js';
import type { PackFile } from '#tools/pack/PackFileBase.js';
import OnDemand from '#/engine/OnDemand.js';
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
// mods (keeping saved player data valid). A per-type floor keeps mod IDs clear of
// base content, so base-content growth below the floor cannot collide with them.
const DEFAULT_ID_FLOOR = 5000;

interface IdMapEntry {
    floor: number;
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
    
    // Map 'archive.file' -> Uint8Array
    // e.g. "1.10" -> data
    overrides: Map<string, Uint8Array> = new Map();

    constructor(dir: string, config: ModConfig) {
        this.path = dir;
        this.config = config;
    }

    async load() {
        // Check for title override
        if (fs.existsSync(path.join(this.path, 'sprites/logo.png'))) {
            await this.packTitle();
        }

        // Check for config overrides (npc, obj, loc, ...)
        const configDir = path.join(this.path, 'config');
        if (fs.existsSync(configDir)) {
            for (const file of fs.readdirSync(configDir)) {
                if (injectableType(path.extname(file)) !== null) {
                    this.configFiles.push(path.join(configDir, file));
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
    scriptPath: string | null = null;

    async packTitle() {
        try {
            // printInfo(`[${this.config.name}] Packing custom title screen...`);
            
            const index = Packet.alloc(3);
            
            // Use mod logo
            const logo = await convertImage(index, path.join(this.path, 'sprites'), 'logo');
            
            // Fallback for build script environment
            let srcDir = Environment.BUILD_SRC_DIR;
            if (!fs.existsSync(srcDir)) {
                // If running from Brumescape_Engine-TS root, and content is sibling
                if (fs.existsSync('../Brumescape_Content')) {
                    srcDir = '../Brumescape_Content';
                } else if (fs.existsSync('../content')) {
                    srcDir = '../content';
                }
            }

            const runes = await convertImage(index, `${srcDir}/title`, 'runes');
            const titlebox = await convertImage(index, `${srcDir}/title`, 'titlebox');
            const titlebutton = await convertImage(index, `${srcDir}/title`, 'titlebutton');

            const b12 = await convertImage(index, `${srcDir}/fonts`, 'b12');
            const p11 = await convertImage(index, `${srcDir}/fonts`, 'p11');
            const p12 = await convertImage(index, `${srcDir}/fonts`, 'p12');
            const q8 = await convertImage(index, `${srcDir}/fonts`, 'q8');

            const title = Jagfile.new();
            // Assuming we keep the original background or allow overriding it too
            if (fs.existsSync(path.join(this.path, 'binary/title.jpg'))) {
                 title.write('title.dat', Packet.load(path.join(this.path, 'binary/title.jpg'), true));
            } else {
                 title.write('title.dat', Packet.load(`${srcDir}/binary/title.jpg`, true));
            }

            title.write('index.dat', index);
            title.write('logo.dat', logo);
            title.write('runes.dat', runes);
            title.write('titlebox.dat', titlebox);
            title.write('titlebutton.dat', titlebutton);
            title.write('b12.dat', b12);
            title.write('p11.dat', p11);
            title.write('p12.dat', p12);
            title.write('q8.dat', q8);

            // title.save() writes to disk, but we want the buffer.
            const buffer = title.encode();
            
            // Create a completely new Uint8Array copy to detach from the packet's internal buffer
            // which gets reused/released
            const data = new Uint8Array(buffer.data.subarray(0, buffer.pos));
            
            // printInfo(`[${this.config.name}] Title override generated: ${data.length} bytes`);
            
            this.overrides.set('title', data);
            buffer.release();
            
        } catch (err) {
            printError(`[${this.config.name}] Failed to pack title: ${err}`);
            console.error(err); // Ensure we see the full error stack
        }
    }
}

class ModManager {
    mods: Mod[] = [];
    modsDir: string = 'mods';
    
    // Cached CRC buffer including mod overrides
    crcBuffer: Uint8Array | null = null;

    // Persisted name -> id assignments per config type (mods/idmap.json)
    idMap: Record<string, IdMapEntry> | null = null;
    idMapDirty = false;

    get idMapPath(): string {
        return path.join(this.modsDir, 'idmap.json');
    }

    async init() {
        if (!fs.existsSync(this.modsDir)) {
            fs.mkdirSync(this.modsDir);
        }
        await this.loadMods();
        this.recalculateCrcs();
    }

    async loadMods() {
        if (!fs.existsSync(this.modsDir)) return;
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

    getOverride(archive: number, file: number): Uint8Array | null {
        // Check for specific archive/file overrides if we implement them
        // For title (archive 0, file 1 in build script, but accessed via web usually)
        if (archive === 1 && file === 1) {
             const title = this.getNamedOverride('title');
             if (title) return title;
        }
        return null; 
    }

    getNamedOverride(name: string): Uint8Array | null {
        for (const mod of this.mods) {
            if (mod.overrides.has(name)) {
                return mod.overrides.get(name)!;
            }
        }
        return null;
    }

    recalculateCrcs() {
        // printInfo('Recalculating CRCs...');
        // Rebuild CrcBuffer based on overrides
        // See CrcTable.ts for original logic
        
        const buffer = Packet.alloc(4 * 9);
        const count = OnDemand.cache.count(0);
        // printInfo(`Cache count for archive 0: ${count}`);
        
        for (let i = 0; i < count; i++) {
            let data: Uint8Array | null = null;
            
            // Check overrides logic
            if (i === 1) { // Title is index 1
                 data = this.getNamedOverride('title');
                 if (data) {
                     // printInfo('Using title override for CRC calculation');
                 } else {
                     // printInfo('No title override found during CRC calculation');
                 }
            }

            // Fallback to cache
            if (!data) {
                data = OnDemand.cache.read(0, i);
            }

            if (data) {
                buffer.p4(Packet.getcrc(data, 0, data.length));
            } else {
                buffer.p4(0);
            }
        }
        
        this.crcBuffer = buffer.data;
        // printInfo('CRC buffer updated.');
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
            entry = { floor: DEFAULT_ID_FLOOR, next: DEFAULT_ID_FLOOR, ids: {} };
            this.idMap![key] = entry;
            this.idMapDirty = true;
        }

        let id = entry.ids[name];
        const occupant = id !== undefined ? pack.pack.get(id) : undefined;
        if (id === undefined || (occupant !== undefined && occupant !== name)) {
            if (id !== undefined) {
                printError(`[ModManager] ${key} id ${id} (${name}) is already used by '${occupant}' (base content grew past the floor?). Reassigning.`);
            }
            id = Math.max(entry.next, entry.floor, pack.max);
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
}

export default new ModManager();
