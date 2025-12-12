import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { printInfo, printError } from '#/util/Logger.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { convertImage } from '#tools/pack/PixPack.js';
import { CrcBuffer, makeCrcs } from '#/cache/CrcTable.js';
import OnDemand from '#/engine/OnDemand.js';

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
    }

    async packTitle() {
        try {
            printInfo(`[${this.config.name}] Packing custom title screen...`);
            
            const index = Packet.alloc(3);
            
            // Use mod logo
            const logo = await convertImage(index, path.join(this.path, 'sprites'), 'logo');
            
            // Use original assets for the rest
            const srcDir = Environment.BUILD_SRC_DIR;
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
            this.overrides.set('title', buffer.data);
            
        } catch (err) {
            printError(`[${this.config.name}] Failed to pack title: ${err}`);
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
        // Rebuild CrcBuffer based on overrides
        // See CrcTable.ts for original logic
        
        const buffer = Packet.alloc(4 * 9);
        const count = OnDemand.cache.count(0);
        
        for (let i = 0; i < count; i++) {
            let data: Uint8Array | null = null;
            
            // Check overrides logic
            if (i === 1) { // Title is index 1
                 data = this.getNamedOverride('title');
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
        
        // Also update the global CrcBuffer if possible or provide access to this one
        // Ideally we replace the global one or ensure web.ts uses this one.
    }
}

export default new ModManager();
