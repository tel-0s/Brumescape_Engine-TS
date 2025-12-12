import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { printInfo, printError } from '#/util/Logger.js';

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
        // Implementation for loading assets would go here
        // For now we just acknowledge existence
    }
}

class ModManager {
    mods: Mod[] = [];
    modsDir: string = 'mods';

    init() {
        if (!fs.existsSync(this.modsDir)) {
            fs.mkdirSync(this.modsDir);
        }
        this.loadMods();
    }

    loadMods() {
        const entries = fs.readdirSync(this.modsDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const modPath = path.join(this.modsDir, entry.name);
                const configPath = path.join(modPath, 'mod.json');

                if (fs.existsSync(configPath)) {
                    try {
                        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ModConfig;
                        const mod = new Mod(modPath, config);
                        this.mods.push(mod);
                        printInfo(`Loaded mod: ${config.name} v${config.version}`);
                        mod.load();
                    } catch (err) {
                        printError(`Failed to load mod at ${modPath}: ${err}`);
                    }
                }
            }
        }
    }

    getOverride(archive: number, file: number): Uint8Array | null {
        // Check all mods for an override
        // In a real implementation, we'd need a more efficient lookup 
        // and a way to map IDs to filenames to check if the mod has the file.
        // For now, this is a placeholder hook.
        return null; 
    }
}

export default new ModManager();

