# Mod loader internals

This guide is for people who add a **capability** to the mod loader, such as a
new kind of mod asset. For the mod author's view (what goes where in a mod
folder), see [`mods/README.md`](../../mods/README.md).

## Files

| Path | What it is |
| --- | --- |
| `src/mod/ModManager.ts` | The singleton: discovery, build lifecycle, hook dispatch and the shared API. |
| `src/mod/ModTypes.ts` | Types: `Mod`, `ModFile`, `ModCapability`, `ModBuildContext`, `ConfigHookArgs`, `CompilerConfig`. |
| `src/mod/ModDiscovery.ts` | Mod discovery, `mods.json`, load order. It has no packer imports, so the CLI can use it. |
| `src/mod/capabilities/index.ts` | **The registration point.** One line per capability. |
| `src/mod/capabilities/*.ts` | One module per capability. |
| `tools/pack/PackAll.ts` | The pack pipeline. It calls the hooks. |
| `tools/mod/CLI.ts` | `bun run mod`: list, enable, disable and create mods. |
| `tools/mod/Fixture.ts` | `bun run mod:fixture`: builds against a fixture mods dir and checks the result. |
| `tools/mod/Inspect.ts` | `bun run mod:inspect`, and the reader API for fixture checks. |
| `tools/mod/fixtures/<name>/` | Fixture mods dirs. |

The capabilities that exist now are the reference examples:

| Module | Mod input | Technique |
| --- | --- | --- |
| `configs.ts` | `config/**/*.<type>`, `config/patch/**/*.<type>` | Registers names in `afterRevalidate`. Injects parsed configs in the `configs` hook, then applies patches (`src/mod/ConfigPatch.ts`), mod by mod. Exports `registerConfigType`. |
| `models.ts` | `models/**/*.ob2` | `registerName` plus `setAsset('model', …)`. `tools/pack/graphics/pack.ts` reads `getAssets('model')`. |
| `textures.ts` | `textures/**/*.png` | `registerName` plus `setAsset('texture', …)`. `tools/pack/sprite/textures.ts` reads `getAsset`. |
| `title.ts` | `title/*.png`, `binary/title.jpg` | `setAsset` only. `tools/pack/sprite/title.ts` reads `getAsset`. |
| `scripts.ts` | `scripts/**/*.rs2` | Stages files in `prepare`, registers script names, adds a compiler source in `beforeCompile`. |
| `script-overrides.ts` | `scripts/**/*.rs2` that redefine a script | Slot A. Plans override chains in `afterRevalidate` (registers the generated `original_*` names). In `beforeCompile`: renames replaced blocks, stages base files under `data/pack/mods/overrides/` and omits the originals (`CompilerConfig.omit`). |
| `spawns.ts` | `spawns.json` | `worldBoot`: places npcs and locs. |
| `init.ts` | mod.json `"init"` | `worldBoot`: runs `[proc,<init>]`. |

## The build pipeline and its hook points

`packClient()` and then `packServer()` run in one process (`bun run build`,
the dev watcher, or the first start of the server). Hooks run in this order.
Within each hook point, capabilities run in registration order.

```
packClient
  ModManager.beginBuild()      load mods (load order), fingerprint check
  prepare                      stage files, validate inputs. Packs are NOT loaded yet.
  beforeRevalidate
  revalidatePack()             every PackFile reloads from base content (content/pack/*.pack)
  afterRevalidate              register names and ids (registerName), set assets (setAsset)
  modelFlags sized to ModelPack.max
  for each stage in: title, configs, interface, media, textures, wordenc,
                     sound, models, maps, music, versionlist
      before.<stage>           ctx.cache is the client cache being written
      <stage>                  the base packer
      after.<stage>
    inside "configs":
      constants                after base .constant files load, before any config is parsed
      configs                  once per config type that is repacked this build
packServer
  beforeSymbols
  generateServerSymbols()      data/symbols/*.sym from the in-memory Packs
  afterSymbols
  beforeCompile(compiler)      edit the generated compiler config
  RuneScript compiler          java -jar RuneScriptCompiler.jar data/pack/mods/neptune.toml
  afterCompile
  ModManager.finishBuild()     saves idmap.json and the fingerprint state

server (World.start, after maps load)
  worldBoot(world)
```

Points to note:

- `afterRevalidate` runs on **every** build, also when nothing changed.
  Register every name there, so ids and compiler symbols are always complete.
  Do not register names only in a hook that runs when a type is repacked.
- The `configs` hook runs only for types that are repacked in this build. When
  the mod set changes, every type is repacked (see
  [Invalidation](#invalidation-the-mod-set-fingerprint)).
- `worldBoot` runs in the server process, not during a build. The build loads
  every capability module too. So a capability module must not import engine
  runtime modules (World, entities, ScriptRunner, …) at the top of the file.
  Import them inside the hook with `await import(...)`. Type-only imports are
  fine. Small leaf modules, like a `const enum`, are fine too (see
  `spawns.ts`).

## Writing a capability

1. Create `src/mod/capabilities/<name>.ts`:

   ```ts
   import ModManager from '#/mod/ModManager.js';
   import type { ModCapability } from '#/mod/ModTypes.js';
   import { SynthPack } from '#tools/pack/PackFile.js';

   const capability: ModCapability = {
       name: 'synth', // unique

       afterRevalidate() {
           for (const file of ModManager.listFiles('synth', '.synth')) {
               ModManager.claim('synth', file.name, file); // warns if an earlier mod defined it
               ModManager.registerName('synth', SynthPack, file.name); // stable id, or the base id
               ModManager.setAsset('synth', file.name, file.path); // the packer reads this
           }
       },

       after: {
           sound(ctx) {
               // ctx.cache is the client cache (FileStream)
           }
       }
   };

   export default capability;
   ```

2. Register it with **one line** in `src/mod/capabilities/index.ts`, under your
   slot's comment:

   ```ts
   ModManager.register((await import('#/mod/capabilities/synth.js')).default);
   ```

   The file has one slot per capability area (A to E). Add your lines directly
   below your slot's comment. Do not change the blank line or the next slot's
   comment. Then parallel branches merge without conflicts.

3. Add a fixture in `tools/mod/fixtures/<name>/` (see
   [Fixtures](#fixtures-and-the-test-harness)).

If the base packer for your asset type reads only the content dir, change that
packer so it also reads `ModManager.getAsset(kind, name)` or
`getAssets(kind)`. `tools/pack/graphics/pack.ts` (models) and
`tools/pack/sprite/textures.ts` are the examples. Keep such edits small. Other
branches may touch the same packer.

## Shared API

All of these are methods on the default export of `#/mod/ModManager.js`.

```ts
// --- mods ---
mods: Mod[]                     // enabled mods, in load order
modsDir: string                 // Environment.BUILD_MODS_DIR (default 'mods')
ctx: ModBuildContext | null     // the build in progress

// --- files ---
listFiles(subdir: string, exts: string | readonly string[], options?: { recursive?: boolean }): ModFile[]
    // Every <mod>/<subdir>/** file with one of the extensions (case-insensitive),
    // mod by mod in load order, sorted by path within a mod. Skips dotfiles.
    // ModFile = { mod, path (absolute), relPath ('config/npcs/a.npc'),
    //             subPath ('npcs/a.npc'), name ('a'), ext ('.npc') }

// --- ids ---
registerName(kind: string, pack: PackFile, name: string): number
    // If `name` is already in the pack (base content or an earlier mod), returns
    // its id. Otherwise assigns a stable id (assignId) and registers it as
    // mod-owned (pack.registerMod: keeps names/max in sync, never saved to the
    // content dir). Use this; do not call pack.register() for mod names.
assignId(kind: string, pack: PackFile, name: string): number
    // The idmap.json allocation with the base-occupant guard (see below)
isBaseName(pack: PackFile, name: string): boolean
    // true if `name` comes from base content (not registered by a mod)

// --- overrides and conflicts ---
claim(kind: string, name: string, file: ModFile): ModFile | null
    // Records that `file` defines `name`. Returns the previous definition. If
    // that came from another mod, logs "<kind> 'x' from A (path) is overridden
    // by B (path)". A previous definition from the SAME mod is returned
    // silently: decide yourself if that is an error.
setAsset(kind: string, name: string, absPath: string): void
getAsset(kind: string, name: string): string | undefined
getAssets(kind: string): ReadonlyMap<string, string>
    // Per-build asset overrides. Later calls win, so set them in load order.

// --- errors ---
error(where: ModFile | Mod, line: number | null, message: string): ModError
    // Returns (does not throw) an error whose message is
    // "[mod <name>] <relPath>:<line>: <message>". `line` is 1-based.
    // Usage: throw ModManager.error(file, 12, 'Invalid property value: x=y');
warn(where: ModFile | Mod, line: number | null, message: string): void

// --- build output ---
stagingDir(sub?: string): string
    // Absolute data/pack/mods/<sub>, created. Engine-local and gitignored.
    // Clean your own subdirectory yourself if you need a fresh one each build.
recordOutput(path: string): void
    // A file or directory under data/ that you wrote and that base packing
    // would not overwrite or delete by itself (for example a NEW map square
    // file). It is deleted before the next build that follows a mod-set change.
markTouched(kind: string): void
    // Mods changed the packed output of `kind` ('.npc', '.if', ...) in this build
shouldVerify(kind: string): boolean
    // BUILD_VERIFY is on and no mod touched `kind`. Use it instead of
    // Environment.BUILD_VERIFY for checksum checks against base content.
forceRebuild: boolean
    // true for the whole build when the mod set changed (shouldBuild* return true)
```

Also exported:

- `#/mod/capabilities/configs.js`: `registerConfigType(extension, pack)` makes
  one more config type injectable from `config/`. The type must go through
  `readConfigs`, and its symbols must come from the in-memory pack in
  `tools/pack/CompilerSymbols.ts`. The idmap kind is the extension without the
  dot. `.dbtable`, `.dbrow` and `.flo` are not registered yet.
- `#/mod/capabilities/scripts.js`: `scriptStagingRoot()` returns
  `data/pack/mods/scripts`, `stagedScripts()` the staged mod script files,
  and `scanScriptHeaders(file)` the `[trigger,subject]` names in a file with
  their line numbers (headers inside comments are skipped).
- `#/mod/RuneScriptSource.js`: reads `.rs2` text without the compiler:
  `scanScriptBlocks(lines)` (header, line range, signature text of every
  block), `parseSignature`, `renameHeader`, `findLabelJumps`,
  `findReferences`, `replaceReferences`.
- `#/mod/ConfigPatch.js`: `parsePatch(lines, parse)` and
  `applyPatch(extension, config, block)`, the config patch format.
- `#tools/pack/config/PackShared.js`: `parseConfigLines(lines, parse,
  requiredProperties, sink)` and `splitConfigLines(text)`. Base content and
  mods use this one config parser.

## Stable ids

- Every new name gets an id from `idmap.json` in the mods dir. The ids are
  grouped by kind: `npc`, `obj`, `model`, `texture`, `script`, ….
- Ids are **contiguous after base content**: `max(pack.max, idmap.next)`.
  Never use a high reserved range. Several systems size arrays by the config
  count. For example, `Player.save` writes every varp, and the client
  allocates arrays indexed by id.
- **Save compatibility**: an id stays reserved in `idmap.json` after its mod is
  removed. So a later mod never reuses it, and saved player data (varps,
  inventories with mod objs) keeps meaning the same thing. The gap that a
  removed mod leaves is packed as an empty config. Packers must accept gaps
  (`configs.get(name)` can be undefined).
- **Base-occupant guard**: if base content now uses a recorded id for a
  different name (base content grew), the mod name gets a new id and an error
  is logged. This breaks saves for that one name only.
- Mod names are only in memory. `PackFile.save()` filters them out, and
  `PackFile.load()` resets them. The content dir's `.pack` files only ever
  hold base names.
- Fixture builds have their own `idmap.json` inside the fixture dir. It is
  gitignored.

## Override semantics

- **Load order**: installed mods are sorted by `name` (plain code-unit order,
  so uppercase sorts first). Then a stable topological sort moves each mod
  after its `dependencies`. A missing or disabled dependency, a cycle, or a
  duplicate name fails the build. `<mods dir>/mods.json` with
  `{ "disabled": [...] }` turns mods off.
- **Later mod wins.** When two mods define the same name, the one later in
  load order wins, and `claim()` logs a warning that names both. Iterate
  `listFiles()` in order and let later entries overwrite earlier ones.
- **A mod name equal to a base name replaces the base entry** (configs,
  models, textures, title sprites). Log it with `printInfo` so it is visible.
- **Two definitions in the same mod** are an error (configs, scripts).
- Scripts follow the same rule. A `[trigger,subject]` that base content or
  an earlier mod defines is replaced (`script-overrides.ts`); the replaced
  block is still compiled as `[label|proc,original_<trigger>_<subject>]`.

## Invalidation: the mod-set fingerprint

Incremental packing (`shouldBuild`, `shouldBuildFile`, `shouldBuildFileAny`
in `tools/pack/PackFile.ts`) compares only base content mtimes. It cannot see
mod changes. So `beginBuild()` hashes the mod set:

- the mods dir path
- the enabled mods in load order (name, version, dir)
- every file of every enabled mod (relative path, size, mtime)
- the loader's own source (`src/mod/**`)

It compares the hash with `data/pack/mods/state.json` from the last
successful build. If they differ, `forceRebuild` is true for the whole build.
Every `shouldBuild*` then returns true, and the outputs recorded with
`recordOutput()` last time are deleted first. The state is written only at
the end of a successful `packServer()`, so a failed build forces the next one
too.

What this means for a capability:

- Use the `shouldBuild*` helpers for any incremental decision. Then a mod
  change repacks your stage with no special case.
- The client cache (`data/pack/main_file_cache.*`) is created new on every
  build, so cache writes need no cleanup.
- Files you add next to base output (for example a new
  `data/pack/server/maps/m60_60`) must be recorded with `recordOutput()`.
  Otherwise they stay behind after the mod is removed.
- `idmap.json` is not in the fingerprint. After a hand edit, run `bun run clean`.

## BUILD_VERIFY

`BUILD_VERIFY=true` compares packed output with checksums of unmodified base
content. When your capability changes the packed output of a kind, call
`ModManager.markTouched(kind)`. Checksum checks must use
`ModManager.shouldVerify(kind)`. It skips the check, with an info line, only
for kinds that mods touched. `readConfigs` and the interface packer already
use it. The configs capability marks each config extension it injects into.

## Scripts and the compiler config

`packServer` writes `data/pack/mods/neptune.toml` on every build. All paths
are absolute:

```ts
interface CompilerConfig {
    sources: string[];   // dirs (searched for .rs2) or single .rs2 files:
                         // [<content>/scripts, data/pack/mods/scripts (if any mod scripts)]
    omit: string[];      // .rs2 files to leave out of compilation entirely
    excluded: string[];  // the compiler's 'excluded': still parsed and type-checked, only not written
    symbols: string[];   // [data/symbols]
    output: string;      // data/pack/server
    checkPointers: boolean;
}
```

`beforeCompile(ctx, compiler)` hooks may edit it. **To replace a base script
without touching the content dir:** write a rewritten copy of the base file
under `stagingDir('<your sub>')`, push that directory (or file) to
`compiler.sources`, and push the original file's absolute path to
`compiler.omit`. When the TOML is written, a source directory that contains an
omitted file is listed as its `.rs2` files without the omitted ones. The
compiler accepts single files as sources. An `omit` entry that matches no
source file fails the build. Do **not** use `excluded` for this: the compiler
still parses and type-checks excluded files, so a duplicate
`[trigger,subject]` still fails. (Tested: a staged copy of `hans.rs2` plus
`omit` compiles, and `[opnpc1,hans]` comes from the staged copy. The same
with `excluded` fails with "already defined".)

`script-overrides.ts` uses this for every base file with a replaced block.
It also edits the staged mod copies in place (renamed headers, rewritten
`original_*` references) and writes line-preserving copies of single blocks
under `data/pack/mods/overrides/copies/`. Each generated script name must be
registered in the `ScriptPack` in `afterRevalidate`: the compiler fails on a
script that has no id in `runescript.sym`.

The scripts capability stages each mod's scripts as
`data/pack/mods/scripts/<mod name>/<path under scripts/>`. Compiler errors
show that staged path. Script names get ids in the in-memory `ScriptPack`
(idmap kind `script`), and `runescript.sym` is generated from it.
`resolveCompilerSources(compiler)` in `tools/pack/PackAll.ts` returns the
effective source list.

## Rules

1. **Never write to the content dir** (`Environment.BUILD_SRC_DIR`). Write mod
   build products under `ModManager.stagingDir()` or the normal `data/pack`
   outputs. `recordOutput` refuses paths outside `data/`. Base packing itself
   still saves `content/pack/*.pack` (upstream behaviour). So two builds must
   never share one content dir at the same time.
2. Register names only through `ModManager.registerName`.
3. Register every name in `afterRevalidate`, on every build.
4. Report authoring mistakes with `throw ModManager.error(file, line, msg)`.
   Do not skip bad input silently.
5. Import engine runtime modules lazily, inside `worldBoot`.
6. Keep edits to shared files small: `PackAll.ts`, `PackFile.ts`,
   `PackShared.ts`, `CompilerSymbols.ts`, `versionlist/pack.ts`,
   `ModManager.ts` and `ModTypes.ts`. Prefer a hook and your own module.

## Fixtures and the test harness

A fixture is a mods dir: `tools/mod/fixtures/<name>/<mod>/mod.json …`. It can
also contain:

- `mods.json`: enable/disable switches.
- `check.ts`: runs after a successful build, with `BUILD_MODS_DIR` set. It
  fails by throwing or by exiting non-zero.
- `expect-fail.txt`: the build must fail, and its output must contain every
  non-empty line of this file.

```sh
bun run mod:fixture <name> [<name> ...]   # build against tools/mod/fixtures/<name>, then check
bun run mod:fixture --all                 # every fixture, in name order
bun run mod:fixture core empty            # core, then a build with no mods: removal works
BUILD_MODS_DIR=tools/mod/fixtures/<name> bun run build        # just build
BUILD_MODS_DIR=tools/mod/fixtures/<name> bun run quickstart   # boot the server with it
bun run build                             # back to the real mods/ afterwards
```

`check.ts` files import readers from `#tools/mod/Inspect.js`:

```ts
getConfig(type, name): Promise<object | null>   // decoded server config from data/pack
readSymbols(file): Map<string, number>           // data/symbols/<file>.sym: name -> id
readCompiledScripts(): Map<string, { id, source }> // script.dat: name -> id and source path
readCache(archive, file) / readCacheGunzip(archive, file) // client cache files
readJagEntry(file, 'logo.dat')                    // an entry of an archive-0 jag file
crcTable(): number[]                               // what /crc serves
readIdMap(modsDir?), readBasePack(type)
expect(condition, message), sameBytes(a, b)
```

The same readers work on the command line:

```sh
bun run mod:inspect config npc jemery_mclabe
bun run mod:inspect sym npc mclabe
bun run mod:inspect script olive_oil
bun run mod:inspect cache 0 1        # the title jag: entries, sizes, CRCs
bun run mod:inspect crc
bun run mod:inspect ids npc
bun run mod:inspect state
```

### Recipe for verifying a capability

1. Add `tools/mod/fixtures/<capability>/` with one or more small mods. Use
   your new asset type, and include a base override and a two-mod conflict
   if they apply. Add `check.ts` assertions with the `Inspect` readers. Add
   an `errors-<capability>` fixture with `expect-fail.txt` for authoring
   errors.
2. Run `bun run mod:fixture <capability> empty`. Your fixture must pass, and
   `empty` must pass right after it. That proves removal drops your content.
3. Run `bun run mod:fixture --all`. Nothing else may break.
4. Optional: boot the server with your fixture
   (`BUILD_MODS_DIR=tools/mod/fixtures/<capability> bun run quickstart`,
   wait for "World ready", check the logs and `curl
   http://localhost/crc`), then stop it.
5. Run `bun run build` with the real `mods/` and `bun run lint`. Check that
   `git status` in the content repo is clean.
