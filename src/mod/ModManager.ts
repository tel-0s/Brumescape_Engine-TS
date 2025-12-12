import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { printInfo, printError } from '#/util/Logger.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { convertImage } from '#tools/pack/PixPack.js';
import OnDemand from '#/engine/OnDemand.js';
import NpcType from '#/cache/config/NpcType.js';
import { packNpcConfigs, parseNpcConfig } from '#tools/pack/config/NpcConfig.js';
import { ConfigLine } from '#tools/pack/config/PackShared.js';

export interface ModConfig {
    name: string;
    version: string;
    author: string;
    description?: string;
    dependencies?: Record<string, string>;
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

        // Check for NPC overrides
        if (fs.existsSync(path.join(this.path, 'config/npc.npc'))) {
            this.hasNpcOverrides = true;
        }

        // Check for scripts
        const scriptDir = path.join(this.path, 'scripts');
        if (fs.existsSync(scriptDir)) {
            // We need to tell the system to include these scripts
            this.scriptPath = scriptDir;
        }
    }

    hasNpcOverrides = false;
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

    async init() {
        if (!fs.existsSync(this.modsDir)) {
            fs.mkdirSync(this.modsDir);
        }
        await this.loadMods();
        this.recalculateCrcs();
    }

    async loadMods() {
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

    // Hook into NPC packing to inject mod configs
    injectNpcs(configs: Map<string, ConfigLine[]>) {
        for (const mod of this.mods) {
            if (!mod.hasNpcOverrides) continue;

            const npcConfigPath = path.join(mod.path, 'config/npc.npc');
            console.log(`[ModManager] Checking for NPC config at: ${npcConfigPath}`);
            
            if (fs.existsSync(npcConfigPath)) {
                // Read and parse the mod's NPC config
                // This logic mirrors readConfigs in PackShared.ts but simplifies for injection
                const content = fs.readFileSync(npcConfigPath, 'utf-8');
                const lines = content.split(/\r?\n/);
                
                let debugname: string | null = null;
                let config: ConfigLine[] = [];

                for (let line of lines) {
                    line = line.trim();
                    if (line.length === 0 || line.startsWith('//')) continue;

                    if (line.startsWith('[')) {
                        if (debugname !== null) {
                            configs.set(debugname, config);
                            printInfo(`[ModManager] Injected NPC: ${debugname}`);
                        }
                        
                        debugname = line.substring(1, line.length - 1);
                        config = [];
                        continue;
                    }

                    const separator = line.indexOf('=');
                    if (separator === -1) continue;

                    const key = line.substring(0, separator);
                    const value = line.substring(separator + 1);

                    // We reuse the existing NpcConfig parser if possible, or manual parse
                    // Since parseNpcConfig needs to be imported:
                    const parsed = parseNpcConfig(key, value);
                    if (parsed !== null && parsed !== undefined) {
                        config.push({ key, value: parsed });
                    }
                }

                if (debugname !== null) {
                    configs.set(debugname, config);
                    printInfo(`[ModManager] Injected NPC: ${debugname}`);
                }
            } else {
                printError(`[ModManager] NPC config file not found: ${npcConfigPath}`);
            }
        }
    }
}

export default new ModManager();
