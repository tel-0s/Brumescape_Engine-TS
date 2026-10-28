import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { printError, printInfo, printWarning } from '#/util/Logger.js';
import type { PackFile } from '#tools/pack/PackFileBase.js';
import { Mod } from '#/mod/ModTypes.js';
import type { ClientStage, CompilerConfig, ConfigHookArgs, ModBuildContext, ModCapability, ModFile } from '#/mod/ModTypes.js';
import { discoverMods, listModTree } from '#/mod/ModDiscovery.js';

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

// idmap kinds whose ids player saves store (Player.save: varp values, inventory
// types, the objs in them). Moving such a mod name to another id would give
// its saved values to whatever takes the old id, so the build stops instead.
const SAVED_KINDS = new Set(['varp', 'inv', 'obj']);

// The mods dir of a normal install. Base packers also keep clear of its
// idmap.json during builds against another mods dir (fixtures, validate), so
// such a build never gives a new base name an id the real mods use.
const DEFAULT_MODS_DIR = 'mods';

class ModManager {
    // Enabled mods in load order
    mods: Mod[] = [];
    // Environment.BUILD_MODS_DIR (default 'mods'); holds idmap.json and mods.json too
    modsDir: string = Environment.BUILD_MODS_DIR;

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
    private touched: Set<string> = new Set();
    // Every file listFiles() returned in this build (see wasListed)
    private listed: Set<string> = new Set();

    // True while a build runs after the mod set changed (see beginBuild).
    // Every shouldBuild*() check in tools/pack/PackFile.ts returns true then.
    forceRebuild = false;
    private fingerprint: string | null = null;
    private modsFingerprint: string | null = null;
    private outputs: Set<string> = new Set();

    get idMapPath(): string {
        return path.join(this.modsDir, 'idmap.json');
    }

    // Fingerprint of the last successful build and the mod outputs it recorded
    get statePath(): string {
        return path.resolve('data/pack/mods/state.json');
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
        this.touched.clear();
        this.listed.clear();

        // Incremental packing (shouldBuild*) only compares base content
        // mtimes, so it cannot see a mod change. Compare a fingerprint of the
        // mod set with the one stored by the last successful build; if it
        // differs, delete the outputs mods recorded last time and force every
        // incremental stage to repack. This is generic: any packer that uses
        // the shouldBuild* helpers is covered.
        this.modsFingerprint = this.computeModsFingerprint();
        this.fingerprint = this.fingerprintWithIdMap(this.modsFingerprint);
        const state = this.readState();
        this.forceRebuild = state === null || state.fingerprint !== this.fingerprint;
        this.outputs = new Set(state?.outputs ?? []);

        if (this.forceRebuild) {
            printInfo(state === null ? '[mods] No record of a previous mod build: repacking everything mods can affect' : '[mods] Mod set changed since the last build: repacking everything mods can affect');
            for (const output of this.outputs) {
                fs.rmSync(path.resolve(output), { recursive: true, force: true });
            }
            this.outputs.clear();
            // Written again by finishBuild(); a failed build forces the next one too
            fs.rmSync(this.statePath, { force: true });
        }

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const manager = this;
        this.ctx = {
            mods: this.mods,
            modelFlags,
            cache: null,
            // a getter: assignId() can still force a full repack during afterRevalidate
            get forceRebuild() {
                return manager.forceRebuild;
            }
        };

        await this.runHook('prepare');
        return this.ctx;
    }

    // Called at the end of a successful packServer()
    finishBuild() {
        this.saveIdMap();
        if (this.modsFingerprint !== null) {
            this.fingerprint = this.fingerprintWithIdMap(this.modsFingerprint);
        }
        this.writeState();
        this.forceRebuild = false;
        this.ctx = null;
    }

    // Hash of everything that decides what mods contribute to a build: the mods
    // dir, the enabled mods in load order, every file in each enabled mod
    // (relative path, size, mtime), the mod loader's own source (src/mod/**)
    // and idmap.json. idmap.json changes during a build, so finishBuild()
    // stores the fingerprint with the saved idmap.json: a later change to it
    // (a hand edit, a restored copy) forces a full repack, because packed
    // configs hold mod ids.
    computeFingerprint(): string {
        return this.fingerprintWithIdMap(this.computeModsFingerprint());
    }

    private fingerprintWithIdMap(modsFingerprint: string): string {
        const hash = crypto.createHash('sha256');
        hash.update(`mods\t${modsFingerprint}\n`);
        hash.update(`idmap\t${fs.existsSync(this.idMapPath) ? fs.readFileSync(this.idMapPath, 'utf-8') : ''}\n`);
        return hash.digest('hex');
    }

    private computeModsFingerprint(): string {
        const hash = crypto.createHash('sha256');
        hash.update(`mods-dir\t${path.resolve(this.modsDir)}\n`);

        const addTree = (label: string, root: string) => {
            if (!fs.existsSync(root)) {
                return;
            }
            for (const file of walk(root, true)) {
                const stat = fs.statSync(file);
                hash.update(`${label}\t${toPosix(path.relative(root, file))}\t${stat.size}\t${stat.mtimeMs}\n`);
            }
        };

        for (const mod of this.mods) {
            hash.update(`mod\t${mod.name}\t${mod.manifest.version}\t${mod.dir}\n`);
            addTree(mod.name, mod.dir);
        }
        addTree('loader', path.resolve('src/mod'));

        return hash.digest('hex');
    }

    // Record a file or directory a capability wrote outside the client cache
    // that base packing would not overwrite or delete by itself (e.g. a new
    // map square). It is deleted before the next build that follows a change
    // to the mod set. Paths must be inside data/.
    recordOutput(file: string) {
        const rel = toPosix(path.relative(process.cwd(), path.resolve(file)));
        if (!rel.startsWith('data/')) {
            throw new Error(`recordOutput: ${file} is outside data/; capabilities must not write elsewhere`);
        }
        this.outputs.add(rel);
    }

    private readState(): { fingerprint: string; outputs: string[] } | null {
        if (!fs.existsSync(this.statePath)) {
            return null;
        }
        try {
            const state = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
            if (typeof state.fingerprint !== 'string' || !Array.isArray(state.outputs)) {
                return null;
            }
            return state;
        } catch (_err) {
            return null;
        }
    }

    private writeState() {
        if (this.fingerprint === null) {
            return;
        }
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        const outputs = Array.from(this.outputs).sort();
        fs.writeFileSync(this.statePath, JSON.stringify({ fingerprint: this.fingerprint, outputs }, null, 4) + '\n');
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

            for (const file of walk(root, recursive)) {
                const ext = path.extname(file).toLowerCase();
                if (!wanted.includes(ext)) {
                    continue;
                }
                this.listed.add(file);

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

    // True if listFiles() returned this file (absolute path) in this build,
    // to any capability. capabilities/files.ts reports the files of enabled
    // mods that nothing listed: they would be silently left out of the build.
    wasListed(file: string): boolean {
        return this.listed.has(file);
    }

    // Every file of a mod (absolute paths, sorted, links followed)
    listModFiles(mod: Mod): string[] {
        return walk(mod.dir, true);
    }

    // Stable id for a new name of the given kind ('npc', 'model', 'script', ...).
    // Reuses the id recorded in idmap.json; otherwise assigns the next id after
    // base content and earlier mod ids.
    //
    // Base packers give new base names ids after reservedIdEnd(), so base
    // content only takes a recorded mod id through a hand-written line in
    // content/pack/<kind>.pack. Then, for a kind that player saves store
    // (varp, inv, obj), the build stops: moving the mod name would hand its
    // saved values to the base name. Any other kind is moved to a new id
    // (warning), and the whole build repacks, so no packed config keeps the
    // old id.
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
            const free = Math.max(pack.max, entry.next);
            if (id !== undefined) {
                const where = `${Environment.BUILD_SRC_DIR}/pack/${pack.type}.pack`;
                if (SAVED_KINDS.has(kind)) {
                    throw new Error(
                        `[mods] ${this.idMapPath} gives ${kind} id ${id} to the mod name '${name}', but base content now uses that id for '${occupant}' (${where}). ` +
                            `Player saves store ${kind} ids, so moving '${name}' would give its saved values to '${occupant}'. ` +
                            `Give '${occupant}' a free id in ${where} (${free} is free), or, if no player save holds '${name}', delete its line from ${this.idMapPath} to give it a new id.`
                    );
                }
                printWarning(`[mods] ${kind} id ${id} (${name}) is now used by base content for '${occupant}' (${where}). Moving ${name} to id ${free} and repacking everything.`);
                this.forceRebuild = true;
            }
            id = free;
            entry.ids[name] = id;
            this.idMapDirty = true;
        }

        if (id + 1 > entry.next) {
            entry.next = id + 1;
            this.idMapDirty = true;
        }

        return id;
    }

    // True for kinds whose ids player saves store (varp, inv, obj). Only these
    // need base content to keep clear of mod ids; for any other kind a mod
    // name that base content takes simply moves (see assignId).
    isSavedKind(kind: string): boolean {
        return SAVED_KINDS.has(kind);
    }

    // One past the highest id that idmap.json keeps for `kind`, for enabled,
    // disabled and removed mods alike (0 when there is none). Base packers
    // (tools/pack/PackFile.ts) give new base names ids from here on, so base
    // content never takes an id that a mod name has. The idmap.json of the
    // default mods dir counts too, when a build uses another mods dir.
    reservedIdEnd(kind: string): number {
        this.loadIdMap();
        const maps = [this.idMap!];
        const defaultPath = path.join(DEFAULT_MODS_DIR, 'idmap.json');
        if (path.resolve(defaultPath) !== path.resolve(this.idMapPath) && fs.existsSync(defaultPath)) {
            try {
                maps.push(JSON.parse(fs.readFileSync(defaultPath, 'utf-8')) as Record<string, IdMapEntry>);
            } catch (_err) {
                // a broken default idmap.json is reported by the build that uses it
            }
        }

        let end = 0;
        for (const map of maps) {
            const entry = map[kind];
            if (!entry) {
                continue;
            }
            end = Math.max(end, entry.next ?? 0);
            for (const id of Object.values(entry.ids ?? {})) {
                end = Math.max(end, id + 1);
            }
        }
        return end;
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

    // Record that mods changed the packed output of `kind` (a config
    // extension like '.npc', or '.if', ...) in this build. BUILD_VERIFY then
    // skips that kind's checksum against unmodified base content.
    markTouched(kind: string) {
        this.touched.add(kind);
    }

    isTouched(kind: string): boolean {
        return this.touched.has(kind);
    }

    // Whether BUILD_VERIFY should compare `kind` with the checksum of
    // unmodified base content: only when it is on and no mod touched `kind`.
    shouldVerify(kind: string): boolean {
        if (!Environment.BUILD_VERIFY) {
            return false;
        }
        if (this.touched.has(kind)) {
            printInfo(`[mods] BUILD_VERIFY: skipping the ${kind} checksum check because mods changed ${kind}`);
            return false;
        }
        return true;
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

    // Configs, patches, constants and interfaces have no end-of-line
    // comments: the base parser keeps all text after '=' as the value, so
    // `name=Bob // a name` names the npc "Bob // a name". Base content never
    // has '//' in a value, so in mod files a '//' after a space or tab is a
    // mistake. `line` is the raw line; `lineNo` is 1-based.
    rejectTrailingComment(file: ModFile, lineNo: number, line: string) {
        const text = line.trim();
        if (text.startsWith('//')) {
            return;
        }
        const at = text.search(/\s\/\//);
        if (at !== -1) {
            throw this.error(file, lineNo, `a comment must be on its own line: text after a value is part of the value, so '${text.substring(at).trim()}' would end up in it. Move the comment to the line above.`);
        }
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

// Links that point nowhere or loop, reported once per process
const reportedLinks = new Set<string>();

// Files under a mod folder, sorted, following symbolic links (see listModTree)
function walk(dir: string, recursive: boolean): string[] {
    return listModTree(dir, recursive, (file, why) => {
        if (!reportedLinks.has(file)) {
            reportedLinks.add(file);
            printWarning(`[mods] ${file} ${why}; skipped`);
        }
    });
}

function formatLocation(where: ModFile | Mod, line: number | null): string {
    if (where instanceof Mod) {
        return `[mod ${where.name}] `;
    }
    return `[mod ${where.mod.name}] ${where.relPath}${line !== null ? `:${line}` : ''}: `;
}

export default new ModManager();
