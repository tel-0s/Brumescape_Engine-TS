// Shared types for the mod loader and its capability modules.
// See src/mod/README.md for how these fit together.
//
// Keep this file free of runtime imports (type-only imports are fine) so it
// can be imported from anywhere without creating import cycles.

import type FileStream from '#/io/FileStream.js';
import type World from '#/engine/World.js';
import type { ConfigLine, ConfigParseCallback } from '#tools/pack/config/PackShared.js';

// mods/<dir>/mod.json
export interface ModManifest {
    name: string;
    version: string;
    author?: string;
    description?: string;
    // name -> version. Only the name is checked (the mod must be installed and
    // enabled); version ranges are informational for now.
    dependencies?: Record<string, string>;
    // Optional [proc,<name>] run once on world boot (see capabilities/init.ts)
    init?: string;
}

export class Mod {
    // mod.json "name": the mod's identity (load order, dependencies, namespacing)
    readonly name: string;
    // Absolute path of the mod's root directory
    readonly dir: string;
    readonly manifest: ModManifest;

    constructor(dir: string, manifest: ModManifest) {
        this.name = manifest.name;
        this.dir = dir;
        this.manifest = manifest;
    }
}

// One file inside an enabled mod, as returned by ModManager.listFiles().
export interface ModFile {
    mod: Mod;
    // Absolute path
    path: string;
    // Path relative to the mod root, '/'-separated (e.g. 'config/npcs/guard.npc')
    relPath: string;
    // Path relative to the listed subdirectory, '/'-separated (e.g. 'npcs/guard.npc')
    subPath: string;
    // Basename without extension (e.g. 'guard')
    name: string;
    // Lower-case extension with the dot (e.g. '.npc')
    ext: string;
}

// Client packing stages, in pipeline order (see tools/pack/PackAll.ts).
// Capabilities may run code before/after each one via ModCapability.before/after.
export const CLIENT_STAGES = ['title', 'configs', 'interface', 'media', 'textures', 'wordenc', 'sound', 'models', 'maps', 'music', 'versionlist'] as const;
export type ClientStage = (typeof CLIENT_STAGES)[number];

export interface ModBuildContext {
    // Enabled mods in load order
    readonly mods: readonly Mod[];
    // Model usage flags, indexed by model id (see versionlist/pack.ts)
    readonly modelFlags: number[];
    // The client cache being written (data/pack). null until the client stages
    // start (i.e. in prepare/beforeRevalidate/afterRevalidate) and during the
    // server stages.
    cache: FileStream | null;
    // True when the mod set changed since the last successful build. Every
    // shouldBuild*() check returns true for the whole build.
    readonly forceRebuild: boolean;
}

// Arguments of the per-config-type hook, called inside readConfigs
// (tools/pack/config/PackShared.ts) after base configs of that type are parsed
// and before they are packed.
export interface ConfigHookArgs {
    // '.npc', '.obj', ...
    extension: string;
    // debugname -> parsed lines. Base content is already in here; mutate it.
    configs: Map<string, ConfigLine[]>;
    // The base parser and required keys for this type (pass to parseConfigLines)
    parse: ConfigParseCallback;
    requiredProperties: string[];
}

// The RuneScript compiler configuration, generated per build into
// data/pack/mods/neptune.toml. All paths are absolute. beforeCompile hooks may
// add sources and excluded paths (the compiler skips any file whose absolute
// path starts with an excluded path).
export interface CompilerConfig {
    sources: string[];
    excluded: string[];
    symbols: string[];
    output: string;
    checkPointers: boolean;
}

type Hook<A extends unknown[] = []> = (ctx: ModBuildContext, ...args: A) => void | Promise<void>;

// A capability module (src/mod/capabilities/<name>.ts) default-exports one of
// these and is registered in src/mod/capabilities/index.ts. Every hook is
// optional. Within a hook point, capabilities run in registration order.
export interface ModCapability {
    name: string;

    // ---- build: packClient (tools/pack/PackAll.ts) ----
    // Mods are loaded and the fingerprint is checked. Stage files into
    // ModManager.stagingDir(), validate inputs. Packs are NOT loaded yet.
    prepare?: Hook;
    // Right before revalidatePack() reloads every PackFile from base content.
    beforeRevalidate?: Hook;
    // Right after revalidatePack(): register mod names into PackFiles
    // (ModManager.registerName) and record asset sources (ModManager.setAsset).
    // Runs on every build, even when nothing changed, so names/ids/symbols are
    // always complete.
    afterRevalidate?: Hook;
    // Around each client packing stage. ctx.cache is set.
    before?: Partial<Record<ClientStage, Hook>>;
    after?: Partial<Record<ClientStage, Hook>>;
    // Inside packConfigs, after base .constant files are loaded into the
    // constant table and before any config type is parsed.
    constants?: Hook<[Map<string, string>]>;
    // Inside readConfigs for each config type that is (re)packed this build.
    configs?: Hook<[ConfigHookArgs]>;

    // ---- build: packServer ----
    beforeSymbols?: Hook;
    // data/symbols/*.sym are written; append or rewrite symbol files here.
    afterSymbols?: Hook;
    // Edit the compiler config (add sources, exclude base files).
    beforeCompile?: Hook<[CompilerConfig]>;
    afterCompile?: Hook;

    // ---- runtime: World.start(), after maps are loaded and scripts are ready ----
    // Runs in the server process (not during a build). Import engine runtime
    // modules lazily (await import(...)) inside this hook, never at the top of
    // a capability file: the build process loads every capability too.
    worldBoot?: (world: typeof World) => void | Promise<void>;
}
