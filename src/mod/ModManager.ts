import fs from 'fs';
import path from 'path';

import { printError, printInfo, printWarning } from '#/util/Logger.js';
import type { PackFile } from '#tools/pack/PackFileBase.js';
import { Mod } from '#/mod/ModTypes.js';
import type { ClientStage, CompilerConfig, ConfigHookArgs, ModBuildContext, ModCapability, ModFile } from '#/mod/ModTypes.js';
import { discoverMods } from '#/mod/ModDiscovery.js';

export { Mod } from '#/mod/ModTypes.js';
export type { ModFile, ModManifest, ModCapability, ModBuildContext } from '#/mod/ModTypes.js';

// Thrown for mod authoring errors. The message names the mod, file and line.
export class ModError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModError';
    }
}

// Persistent mod ID allocation (mods/idmap.json). New names get stable ids so
// they survive rebuilds and adding/removing other mods (keeping saved player
// data valid). IDs are assigned contiguously right after base content, NOT in a
// high reserved range: the engine packs configs densely and several systems
// are sized to the config count (e.g. Player.save writes every varp into a
// fixed buffer; the client allocates id-indexed arrays).
interface IdMapEntry {
    next: number;
    ids: Record<string, number>;
}

type HookName = 'prepare' | 'beforeRevalidate' | 'afterRevalidate' | 'beforeSymbols' | 'afterSymbols' | 'afterCompile';

class ModManager {
    // Enabled mods in load order
    mods: Mod[] = [];
    modsDir: string = 'mods';

    // Registered capability modules, in registration order
    readonly capabilities: ModCapability[] = [];
    private capabilitiesLoaded = false;

    // Context of the build in progress (null outside packClient/packServer)
    ctx: ModBuildContext | null = null;

    // Persisted name -> id assignments per kind (mods/idmap.json)
    private idMap: Record<string, IdMapEntry> | null = null;
    private idMapDirty = false;

    // Per-build state, reset by beginBuild()
    private claims: Map<string, Map<string, ModFile>> = new Map();
    private assets: Map<string, Map<string, string>> = new Map();

    get idMapPath(): string {
        return path.join(this.modsDir, 'idmap.json');
    }

    // ------------------------------------------------------------------------
    // Discovery

    async init() {
        if (!fs.existsSync(this.modsDir)) {
            fs.mkdirSync(this.modsDir, { recursive: true });
        }

        this.loadMods();
        await this.loadCapabilities();
    }

    private loadMods() {
        // Reset first so repeated loads (::rebuild re-runs init) replace the
        // list instead of appending duplicates.
        this.mods = [];
        this.idMap = null;

        // Sorted by name, then topologically by dependencies; mods disabled
        // in mods.json are skipped. Throws on a missing dependency or a cycle.
        const { mods, disabled, warnings } = discoverMods(this.modsDir);
        for (const warning of warnings) {
            printWarning(`[mods] ${warning}`);
        }

        this.mods = mods;
        if (mods.length > 0) {
            printInfo(`[mods] Load order: ${mods.map(m => `${m.name} v${m.manifest.version}`).join(', ')}`);
        }
        if (disabled.length > 0) {
            printInfo(`[mods] Disabled in mods.json: ${disabled.map(m => m.name).join(', ')}`);
        }
    }

    private async loadCapabilities() {
        if (this.capabilitiesLoaded) {
            return;
        }
        this.capabilitiesLoaded = true;
        // Imported lazily: capability modules import tools/pack code, which in
        // turn imports this module.
        await import('#/mod/capabilities/index.js');
    }

    // Called once per capability from src/mod/capabilities/index.ts
    register(capability: ModCapability) {
        if (this.capabilities.some(c => c.name === capability.name)) {
            throw new Error(`Mod capability '${capability.name}' is registered twice`);
        }
        this.capabilities.push(capability);
    }

    // ------------------------------------------------------------------------
    // Build lifecycle (called by tools/pack/PackAll.ts)

    async beginBuild(modelFlags: number[]): Promise<ModBuildContext> {
        await this.init();

        this.claims.clear();
        this.assets.clear();

        this.ctx = {
            mods: this.mods,
            modelFlags,
            cache: null,
            forceRebuild: false
        };

        await this.runHook('prepare');
        return this.ctx;
    }

    finishBuild() {
        this.saveIdMap();
        this.ctx = null;
    }

    // ------------------------------------------------------------------------
    // Hook dispatch

    private requireCtx(): ModBuildContext {
        if (!this.ctx) {
            throw new Error('Mod build hooks can only run during a build (call ModManager.beginBuild first)');
        }
        return this.ctx;
    }

    async runHook(name: HookName) {
        const ctx = this.requireCtx();
        for (const cap of this.capabilities) {
            const hook = cap[name];
            if (hook) {
                await hook(ctx);
            }
        }
    }

    // Runs before:<stage> hooks, the stage itself, then after:<stage> hooks.
    async runStage(stage: ClientStage, fn: () => void | Promise<void>) {
        const ctx = this.requireCtx();
        for (const cap of this.capabilities) {
            const hook = cap.before?.[stage];
            if (hook) {
                await hook(ctx);
            }
        }

        await fn();

        for (const cap of this.capabilities) {
            const hook = cap.after?.[stage];
            if (hook) {
                await hook(ctx);
            }
        }
    }

    async runConstantsHook(constants: Map<string, string>) {
        // packConfigs may run outside a mod build (tooling); nothing to add then
        if (!this.ctx) {
            return;
        }
        for (const cap of this.capabilities) {
            if (cap.constants) {
                await cap.constants(this.ctx, constants);
            }
        }
    }

    async runConfigHook(args: ConfigHookArgs) {
        if (!this.ctx) {
            return;
        }
        for (const cap of this.capabilities) {
            if (cap.configs) {
                await cap.configs(this.ctx, args);
            }
        }
    }

    async runCompileHook(compiler: CompilerConfig) {
        const ctx = this.requireCtx();
        for (const cap of this.capabilities) {
            if (cap.beforeCompile) {
                await cap.beforeCompile(ctx, compiler);
            }
        }
    }

    // Called from World.start() in the server process
    async runWorldBoot(world: Parameters<NonNullable<ModCapability['worldBoot']>>[0]) {
        if (!this.capabilitiesLoaded) {
            await this.init();
        }
        for (const cap of this.capabilities) {
            if (!cap.worldBoot) {
                continue;
            }
            try {
                await cap.worldBoot(world);
            } catch (err) {
                printError(`[mods] ${cap.name}: world boot failed: ${err instanceof Error ? err.message : err}`);
            }
        }
    }

    // ------------------------------------------------------------------------
    // Shared API for capability modules

    // Every file under <mod>/<subdir>/ (recursively) with one of the given
    // extensions, for each enabled mod in load order. Within a mod, files are
    // sorted by path. Dotfiles and dot-directories are skipped.
    listFiles(subdir: string, exts: string | readonly string[], options: { recursive?: boolean } = {}): ModFile[] {
        const wanted = (typeof exts === 'string' ? [exts] : exts).map(e => e.toLowerCase());
        const recursive = options.recursive ?? true;
        const out: ModFile[] = [];

        for (const mod of this.mods) {
            const root = path.join(mod.dir, subdir);
            if (!fs.existsSync(root)) {
                continue;
            }

            const found: string[] = [];
            walk(root, recursive, found);
            found.sort();

            for (const file of found) {
                const ext = path.extname(file).toLowerCase();
                if (!wanted.includes(ext)) {
                    continue;
                }

                out.push({
                    mod,
                    path: file,
                    relPath: toPosix(path.relative(mod.dir, file)),
                    subPath: toPosix(path.relative(root, file)),
                    name: path.basename(file, path.extname(file)),
                    ext
                });
            }
        }

        return out;
    }

    // Stable id for a new name of the given kind ('npc', 'model', 'script', ...).
    // Reuses the id recorded in idmap.json; otherwise assigns the next id after
    // base content and earlier mod ids. If base content now occupies the
    // recorded id with a different name, the name is reassigned (and logged).
    assignId(kind: string, pack: PackFile, name: string): number {
        this.loadIdMap();

        let entry = this.idMap![kind];
        if (!entry) {
            entry = { next: 0, ids: {} };
            this.idMap![kind] = entry;
            this.idMapDirty = true;
        }

        let id = entry.ids[name];
        const occupant = id !== undefined ? pack.pack.get(id) : undefined;
        if (id === undefined || (occupant !== undefined && occupant !== name)) {
            if (id !== undefined) {
                printError(`[mods] ${kind} id ${id} (${name}) is already used by '${occupant}' (base content changed?). Reassigning.`);
            }
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

    // Register a mod name into a PackFile and return its id. If the name
    // already exists (base content, or an earlier mod) its id is returned
    // unchanged; otherwise a stable id is assigned (assignId) and the name is
    // registered as mod-owned, which keeps it out of content/pack/*.pack.
    registerName(kind: string, pack: PackFile, name: string): number {
        const existing = pack.getByName(name);
        if (existing !== -1) {
            return existing;
        }

        const id = this.assignId(kind, pack, name);
        pack.registerMod(id, name);
        printInfo(`[mods] Registered ${kind} ${name} (ID: ${id})`);
        return id;
    }

    // True if the name belongs to base content (not registered by a mod)
    isBaseName(pack: PackFile, name: string): boolean {
        return pack.getByName(name) !== -1 && !pack.modNames.has(name);
    }

    // Record that `file` defines `name` of `kind`. Returns the previous
    // definition (if any). When it came from another mod, the override is
    // logged; later mods in load order win. A second definition in the SAME
    // mod is returned too; callers decide whether that is an error.
    claim(kind: string, name: string, file: ModFile): ModFile | null {
        let byName = this.claims.get(kind);
        if (!byName) {
            byName = new Map();
            this.claims.set(kind, byName);
        }

        const previous = byName.get(name) ?? null;
        byName.set(name, file);

        if (previous && previous.mod !== file.mod) {
            printWarning(`[mods] ${kind} '${name}' from ${previous.mod.name} (${previous.relPath}) is overridden by ${file.mod.name} (${file.relPath})`);
        }

        return previous;
    }

    // Asset overrides: the absolute path of the mod file that replaces or adds
    // asset `name` of `kind` (e.g. setAsset('texture', 'bark', '/.../bark.png')).
    // Base packers call getAsset() and fall back to base content.
    setAsset(kind: string, name: string, absPath: string) {
        let byName = this.assets.get(kind);
        if (!byName) {
            byName = new Map();
            this.assets.set(kind, byName);
        }
        byName.set(name, absPath);
    }

    getAsset(kind: string, name: string): string | undefined {
        return this.assets.get(kind)?.get(name);
    }

    // All assets of a kind (name -> absolute path), e.g. to add mod-only names
    getAssets(kind: string): ReadonlyMap<string, string> {
        return this.assets.get(kind) ?? new Map();
    }

    // Engine-local, gitignored scratch space for mod build products
    // (data/pack/mods/<sub>). Never write mod data into the content dir.
    stagingDir(sub: string = ''): string {
        const dir = path.resolve('data/pack/mods', sub);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    // A mod authoring error: '[mod <name>] <relPath>:<line>: <message>'.
    // `line` is 1-based; pass null when there is no meaningful line.
    error(where: ModFile | Mod, line: number | null, message: string): ModError {
        return new ModError(formatLocation(where, line) + message);
    }

    warn(where: ModFile | Mod, line: number | null, message: string) {
        printWarning(formatLocation(where, line) + message);
    }

    // ------------------------------------------------------------------------
    // idmap persistence

    private loadIdMap() {
        if (this.idMap) {
            return;
        }
        if (fs.existsSync(this.idMapPath)) {
            this.idMap = JSON.parse(fs.readFileSync(this.idMapPath, 'utf-8')) as Record<string, IdMapEntry>;
        } else {
            this.idMap = {};
        }
    }

    saveIdMap() {
        if (!this.idMap || !this.idMapDirty) {
            return;
        }
        fs.writeFileSync(this.idMapPath, JSON.stringify(this.idMap, null, 4) + '\n');
        this.idMapDirty = false;
    }
}

function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

function walk(dir: string, recursive: boolean, out: string[]) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (recursive) {
                walk(full, recursive, out);
            }
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
}

function formatLocation(where: ModFile | Mod, line: number | null): string {
    if (where instanceof Mod) {
        return `[mod ${where.name}] `;
    }
    return `[mod ${where.mod.name}] ${where.relPath}${line !== null ? `:${line}` : ''}: `;
}

export default new ModManager();
