import fs from 'fs';
import { parentPort } from 'worker_threads';

import Environment from '#/util/Environment.js';
import { loadFile } from '#tools/pack/Parse.js';
import { printError, printFatalError } from '#/util/Logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PackFileValidator = (packfile: PackFile, ...args: any[]) => void;

export class PackFile {
    type: string;
    validator: PackFileValidator | null = null;
    validatorArgs: any[] = [];
    pack: Map<number, string> = new Map();
    names: Set<string> = new Set();
    nameToId: Map<string, number> = new Map();
    max: number = 0;
    // Names registered by mods (registerMod). They live only in memory for the
    // current build and are never written to the content dir by save().
    modNames: Set<string> = new Set();

    get size() {
        return this.pack.size;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(type: string, validator: PackFileValidator | null = null, ...validatorArgs: any[]) {
        this.type = type;
        this.validator = validator;
        this.validatorArgs = validatorArgs;
        this.reload();
    }

    reload() {
        try {
            if (this.validator !== null) {
                this.validator(this, ...this.validatorArgs);
            } else {
                this.load(`${Environment.BUILD_SRC_DIR}/pack/${this.type}.pack`);
            }
        } catch (err) {
            if (err instanceof Error) {
                if (parentPort) {
                    printError(err.message);
                } else {
                    printFatalError(err.message);
                }
            }
        }
    }

    load(path: string) {
        this.pack = new Map();
        // nameToId must be reset too, or names from a previous load (e.g. mod
        // names from the previous build in a long-running dev thread) would
        // still resolve after reload.
        this.nameToId = new Map();
        this.modNames = new Set();
        this.names = new Set();
        this.max = 0;

        if (!fs.existsSync(path)) {
            return;
        }

        const lines = loadFile(path);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length === 0 || !/^\d+=/g.test(line)) {
                continue;
            }

            const parts = line.split('=');
            if (parts[1].length === 0) {
                throw new Error(`Pack file has an empty name ${path}:${i + 1}`);
            }

            this.register(parseInt(parts[0]), parts[1]);
        }
        this.refreshNames();
    }

    clear() {
        this.pack.clear();
        this.names.clear();
        this.nameToId.clear();
        this.modNames.clear();
        this.max = 0;
    }

    register(id: number, name: string) {
        this.pack.set(id, name);
        this.nameToId.set(name, id);
    }

    // Register a mod-provided name (see ModManager.registerName). Keeps names
    // and max in sync, since dense packers loop 0..max.
    registerMod(id: number, name: string) {
        this.register(id, name);
        this.names.add(name);
        this.modNames.add(name);
        if (id + 1 > this.max) {
            this.max = id + 1;
        }
    }

    delete(id: number) {
        const name = this.pack.get(id);

        if (typeof name !== 'undefined') {
            this.pack.delete(id);
            this.nameToId.delete(name);

            this.refreshNames();
        }
    }

    deleteByName(name: string) {
        const id = this.nameToId.get(name);

        if (typeof id !== 'undefined') {
            this.nameToId.delete(name);
            this.pack.delete(id);

            this.refreshNames();
        }
    }

    refreshNames() {
        this.names = new Set(this.pack.values());
        if (this.names.size) {
            this.max = Math.max(...Array.from(this.pack.keys())) + 1;
        }
    }

    save() {
        if (!fs.existsSync(`${Environment.BUILD_SRC_DIR}/pack`)) {
            fs.mkdirSync(`${Environment.BUILD_SRC_DIR}/pack`, { recursive: true });
        }

        fs.writeFileSync(
            `${Environment.BUILD_SRC_DIR}/pack/${this.type}.pack`,
            Array.from(this.pack.entries())
                .filter(([_id, name]) => !this.modNames.has(name))
                .sort((a, b) => a[0] - b[0])
                .map(([id, name]) => `${id}=${name}`)
                .join('\n') + '\n'
        );
    }

    getById(id: number): string {
        return this.pack.get(id) ?? '';
    }

    getByName(name: string): number {
        const index = this.nameToId.get(name);
        if (typeof index === 'undefined') {
            return -1;
        }

        return index;
    }
}
