# Brumescape modding guide

Brumescape mods add to the 2004 game, or change it, without changing the
content repository. A mod can add new lands, quests, items, npcs, interfaces,
models, animations, sounds and music. A mod can also change base content: it
can replace or patch configs, scripts, interfaces, sprites and map squares.

This guide is for mod authors. To add a new kind of mod asset to the loader
itself, read [`src/mod/README.md`](src/mod/README.md).

## Contents

- [What a mod is](#what-a-mod-is)
- [Quick start](#quick-start)
- [mod.json](#modjson)
- [Enable, disable and load order](#enable-disable-and-load-order)
- [Folder layout](#folder-layout)
- [Names, ids and overrides](#names-ids-and-overrides)
- [Configs](#configs) and [config patches](#config-patches)
- [Data types: constants, tables, floors, categories](#data-types-constants-tables-floors-categories)
- [Scripts](#scripts) and [script overrides](#script-overrides)
- [Models and textures](#models-and-textures)
- [Animations](#animations)
- [Interfaces and sprites](#interfaces-and-sprites)
- [Title screen](#title-screen)
- [Audio](#audio)
- [spawns.json](#spawnsjson)
- [Maps and new lands](#maps-and-new-lands)
- Walkthroughs: [making a new land](#walkthrough-making-a-new-land), [making a quest](#walkthrough-making-a-quest)
- [Building, testing and debugging](#building-testing-and-debugging)
- [Tools reference](#tools-reference)
- [Limits and known gaps](#limits-and-known-gaps)

## What a mod is

A mod is a folder in `mods/` with a `mod.json` file. Each build
(`bun run build`, or the dev server's watcher) packs every enabled mod into
the client cache and the server data, together with base content.

- Mods never change the content repository (`../content`). Everything a mod
  makes goes into `data/`.
- A mod uses the same file formats as base content: configs, RuneScript,
  `.if` interfaces, `.jm2` maps, PNG sprites and textures, `.ob2` models,
  `.synth` sounds and MIDI music. Some formats have mod-only additions, such
  as patches and names instead of numeric ids.
- The build checks what mods give it. A mistake stops the build with the mod,
  the file and the line, for example
  `[mod MyMod] config/npcs/guard.npc:7: Invalid property value: hitpoints=lots`.

## Quick start

```sh
bun run mod create MyMod --author you   # scaffold mods/MyMod/ with every folder
bun run mod validate MyMod              # build base content plus only this mod
bun run build                           # build base content plus every enabled mod
bun run quickstart                      # start the server; open http://localhost/ (Linux: port 8888)
```

`bun run mod create` without a name asks questions instead. It makes:

```
mods/MyMod/
  mod.json            every supported field
  spawns.json         empty npcs, locs and objs lists
  README.md           what goes in each folder
  scripts/mymod.rs2   the init proc and a ::~mymod debugproc
  config/  config/patch/  interfaces/  sprites/  models/  textures/  anims/
  maps/  synth/  songs/  jingles/  title/  binary/
```

All folders are optional. Delete the folders that you do not use.

## mod.json

```json
{
    "name": "MyMod",
    "version": "1.0.0",
    "author": "you",
    "description": "What it adds",
    "dependencies": { "OtherMod": "1.0.0" },
    "init": "mymod_init"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The identity of the mod: letters, digits, `_`, `-`, `.`. It must be unique. Load order, dependencies and `mods.json` use it. |
| `version` | yes | Shown in the build log. |
| `author`, `description` | no | Information only. |
| `dependencies` | no | `{ "<mod name>": "<version>" }`. Each listed mod must be installed and enabled. It loads before this mod. Versions are not checked yet. |
| `init` | no | A proc name. `[proc,<init>]` runs on every server start, after the map loads. There is no player: use it for world setup. If the proc does not exist, the server logs a warning. |

## Enable, disable and load order

- `mods/mods.json` turns mods off without deleting them:
  `{ "disabled": ["MyMod"] }`. If the file does not exist, every mod is
  enabled.
- `bun run mod list` shows the load order. `bun run mod disable MyMod` and
  `bun run mod enable MyMod` edit `mods.json`. Rebuild after a change.
- **Load order**: mods are sorted by `name` (plain character order, so
  uppercase letters come before lowercase), then each mod moves after its
  dependencies. A missing or disabled dependency, a dependency cycle or two
  mods with the same name stop the build.
- Load order decides which mod wins when two mods change the same thing
  (see [Override rules](#override-rules)). To be sure that your mod loads
  after another mod, put that mod in `dependencies`.

## Folder layout

All folders are optional. Subfolders are allowed, except in `title/` and
`binary/`, and for the zone lists in `maps/`.

| Path in the mod | Contents | Section |
| --- | --- | --- |
| `mod.json` | The mod. | [mod.json](#modjson) |
| `config/**/*.npc .obj .loc .seq .spotanim .idk .enum .struct .hunt .mesanim .varp .varn .vars .param .inv` | Configs, same syntax as base content. | [Configs](#configs) |
| `config/**/*.constant .dbtable .dbrow .flo` | Constants, database tables and rows, floors. | [Data types](#data-types-constants-tables-floors-categories) |
| `config/patch/**/*.<type>` | Patches: change some properties of an existing config. | [Config patches](#config-patches) |
| `scripts/**/*.rs2` | RuneScript: new scripts, and overrides of existing scripts. | [Scripts](#scripts) |
| `interfaces/**/*.if`, `*.ifpatch` | New or replaced interfaces, and changes to existing ones. | [Interfaces](#interfaces-and-sprites) |
| `sprites/**/<name>.png` (+ `meta/`) | 2D sprites in the media archive. | [Sprites](#sprites) |
| `models/**/<name>.ob2` | Models in the cache format. | [Models](#models-and-textures) |
| `models/**/<name>.obj` (+ `.mtl`, `<name>.json`) | Wavefront OBJ models, converted at build time. | [Models from OBJ](#models-from-obj) |
| `textures/**/<name>.png` (+ `meta/`) | Textures. | [Textures](#textures) |
| `anims/**/<set>.json` | Animation sets. | [Animations](#animations) |
| `maps/**/m<x>_<z>.jm2`, `m<x>_<z>.patch.jm2` | Map squares: new, replacements and patches. | [Maps](#maps-and-new-lands) |
| `maps/free2play.csv`, `maps/multiway.csv` | Zones to add to or remove from the free-to-play and multi-combat lists. | [Zones](#free-to-play-and-multi-combat-zones) |
| `synth/**/*.synth` | Sound effects. | [Audio](#audio) |
| `songs/**/*.mid`, `jingles/**/*.mid` | Music. | [Audio](#audio) |
| `title/logo.png runes.png titlebox.png titlebutton.png` | Title screen sprites. | [Title screen](#title-screen) |
| `binary/title.jpg` | Title screen background. | [Title screen](#title-screen) |
| `spawns.json` | npcs, locs and objs placed when the server starts. | [spawns.json](#spawnsjson) |

Other files, such as a `README.md` in the mod root, are ignored. Files whose
name starts with `.` are ignored everywhere. In `maps/`, every file must be a
map square or a zone list. `.if` files under `scripts/` or `config/` stop
the build, with a message that tells you to move them.

## Names, ids and overrides

You write names everywhere: `model1=my_model`, `0 30 30: my_tree`,
`inv_add(inv, my_item, 1)`. The build gives every new name a numeric id.

### Stable ids and player saves

- A **new name** (one that base content does not use) gets an id that comes
  after the ids of base content. The id is saved in `mods/idmap.json`, and
  every later build gives the name the same id.
- **Commit `idmap.json` and never delete it.** Player saves store ids:
  items in inventories and the bank, varp values (quest progress). If the file
  is lost, names can get other ids, and old saves then point at the wrong
  items and varps.
- The ids of a removed mod stay reserved in `idmap.json`, so a later mod
  never reuses them. This leaves gaps in the ids; the build packs an empty
  config (or a placeholder texture) for each one.
- New base content never takes a mod id: when base content gets a new
  config or script, the build gives it an id after every id in
  `idmap.json`. Only a hand-written line in `content/pack/<kind>.pack` can
  take a mod id. For a varp, inv or obj (saves store these ids) the build
  then stops and names a free id; for any other kind the mod name moves to a
  new id with a warning.
- Mod ids depend on the install: two servers with different mods give
  different ids to the same name. **Never write a numeric id for something
  that a mod defines.** Use the name.
- Removing a mod does not clean player saves. Items of a removed mod stay in
  the saves with their old ids. Do not remove a mod from a live world that
  players have used.

### Override rules

These rules apply to every kind of asset:

- **A base name replaces the base entry.** A `[hans]` npc config, a
  `model_2429_obj.ob2` model, a `bark.png` texture, a `questlist.if`
  interface or an `m50_50.jm2` map square replaces the base one. The build
  logs each replacement. A replaced config, interface or map square is
  replaced as a whole.
- **To change only part of it, use a patch**: [config patches](#config-patches),
  [interface patches](#patch-files-ifpatch) and
  [map square patches](#patches). Patches from several mods add up.
- **When two mods use the same name, the mod that loads later wins.** The
  build logs a warning that names both mods.
- **The same name twice in one mod is an error.**
- **Scripts** follow the same rules: a `[trigger,subject]` that base content
  or an earlier mod defines is replaced, and the replaced script can still be
  called. See [Script overrides](#script-overrides).

## Configs

Put configs anywhere under `config/`. The extension is the config type:
`.npc .obj .loc .seq .spotanim .idk .enum .struct .hunt .mesanim .varp .varn
.vars .param .inv`, and also `.constant .dbtable .dbrow .flo` (see
[Data types](#data-types-constants-tables-floors-categories)). The syntax is
the same as in base content: a `[name]` line, and then `key=value` lines.

```
// config/npcs.npc
[island_warden]
name=Island warden
desc=Keeps an eye on the island.
model1=model_215_idk
head1=model_53_idk_head
walkanim=human_walk_f,human_walk_b,human_walk_l,human_walk_r
readyanim=human_ready
op1=Talk-to
```

- Mod configs use the same parser as base content. You can use base and mod
  constants (`^name`) and refer to base or mod names (models, seqs, params,
  categories and so on).
- A comment (`//`) must be on its own line, in configs, patches and
  interfaces. Text after a value is part of the value: `name=Bob // a name`
  sets the name to `Bob // a name`. (Map files and scripts allow comments at
  the end of a line.)
- A varp that must be saved with the player needs `scope=perm`.
- A config with a base name replaces the whole base config, so give every
  key that you need. To change only some keys, use a patch.

### Config patches

A patch changes some properties of a config and keeps all the others. Put
patch files under `config/patch/` (subfolders are allowed). The extension
is the config type: `config/patch/npcs.npc`, `config/patch/shop.inv`. Every
config type that mods can add can also be patched.

```
// mods/MyQuest/config/patch/npcs.npc
[man]
// set: replaces the name
name=Bob
// numbered keys are separate keys: only op3 changes
op3=Steal-from
// remove: the Attack option goes away
-op2
// list key: replaces the stabdefence entry
param=stabdefence,5
// list key: adds an entry (no myquest_flag yet)
param=myquest_flag,1
// removes one entry of a list key
-param=slashdefence
```

| Line | Effect |
| --- | --- |
| `key=value` | Set. Every `key` line is replaced by this one, at the place of the first. Numbered keys (`op1`, `model2`, `recol1s`, `stock3`, `patrol4`, ...) are different keys, so only that one changes. A second `key=` line for the same key in one block adds a second value. |
| `key=value` (list key) | Replaces the entry with the same sub-key, or adds the entry after the others. |
| `+key=value` | Adds a line after the existing `key` lines. It never replaces. Use it for lists without sub-keys, such as `val` in an `inputtype=autoint` enum. |
| `-key` | Removes every `key` line. |
| `-key=subkey` | Removes the entry of a list key with this sub-key. |

List keys and their sub-key (the text before the first comma):

| Key | Config types | Sub-key |
| --- | --- | --- |
| `param=<param>,<value>` | every type with params (npc, obj, loc, struct, ...) | the param name |
| `val=<key>,<value>` | enum, except `inputtype=autoint` | the enum key |
| `data=<column>,<values>` | dbrow | the column name |
| `column=<name>,<types>` | dbtable | the column name |

Rules:

- Values go through the base parser: `^constants`, names and validation work
  as in a full config, and a mistake stops the build with the file and line.
- The config must already exist: in base content, in a mod earlier in the
  load order, or in this mod's own `config/` files. A patch never creates a
  config. To add a new config, put it outside `config/patch/`.
- One block per config in each mod.
- Mods apply in load order. In each mod, its full configs apply first and
  then its patches. When two mods patch the same config, both patches apply.
  For the same key, the later mod's value wins.
- A later mod that defines the whole config (outside `config/patch/`)
  replaces it, together with the earlier patches. The build warns.
- Removing a property that is not there gives a warning. Removing a required
  property (`type` of a param) is an error.
- The build logs each patch, for example
  `[mods] MyQuest patches base .npc [man]: name, op3, -op2, param=stabdefence`.

## Data types: constants, tables, floors, categories

All of these go in `config/`. The usual [override rules](#override-rules)
apply.

### Constants

```
// config/myquest.constant
^myquest_complete = 2
^myquest_label = "My Quest"
```

- One constant per line: `^name = value`. Names are lowercase letters,
  digits and underscores.
- Constants work in your mod's configs (`vislevel=^my_vis`,
  `data=price,^my_price`) and in your scripts.
- **Clashes are errors.** If base content or an earlier mod already defines
  the name, the build stops. To replace a constant on purpose, write
  `override ^name = value`. `override` with nothing to override is also an
  error. The same name twice in one mod is always an error.
- Overriding a base constant changes it for all base configs and scripts
  too. Use it with care.

### Database tables and rows

`config/**/*.dbtable` and `*.dbrow` use the same syntax as base content (see
`content/scripts/music/configs/musicregion.dbtable`):

```
[my_shops]
column=npc,npc,INDEXED,REQUIRED
column=price,int,REQUIRED

[my_shop_a]
table=my_shops
data=npc,island_warden
data=price,^my_price
```

- A new table or row gets a stable id. Rows can refer to mod npcs, objs,
  constants, interface components and other mod rows.
- **Add rows to a base table** with `table=<base table>`, for example
  `table=musicregion` or `table=music`.
- **Replace a base row** with a `[row]` that has the base row's name. It
  replaces the whole row. To change one column, use a
  [patch](#config-patches) (`data=<column>,...`).
- **Replacing a base table** replaces it as a whole. Base rows must still
  fit its columns.
- In scripts: `db_find(my_shops:npc, island_warden)`, `db_findnext` and
  `db_getfield($row, my_shops:price, 0)`.

### Floors

```
// config/island.flo
[island_moss]
colour=0x2E5A2A

[island_path]
overlay=yes
colour=0x7A5C3A
// optional: a base or mod texture, and occlusion
texture=planks
occlude=no
```

- Keys: `colour` (0xRRGGBB), `overlay` (`yes` = overlay floor, otherwise
  underlay), `occlude`, `texture` (a base or mod texture; its id must be 255
  or less).
- New floors get flo ids after the 89 base floors. The build logs each one,
  for example `[mods] floor island_moss: flo id 89; in a .jm2 map write uisland_moss (packed as u90)`.
- **Use floors by name in maps**: `uisland_moss` for an underlay,
  `oisland_path` for an overlay. See [The .jm2 format](#the-jm2-format).
- **Limits** of the map format: overlay floors up to flo id 254, underlay
  floors up to flo id 173. The build stops when a new floor is past its
  limit. That leaves room for about 85 new underlay floors across all mods.
  Floor ids of removed mods stay reserved.
- A floor with a base name (for example `[lightgrass]`) replaces the base
  floor everywhere it is used.

### Categories

Write `category=<name>` in a mod `.npc`, `.obj` or `.loc`. A name that base
content does not have becomes a new category with a stable id. Scripts can
then use it, for example `[opnpc1,_island_folk]` runs for every npc in the
category `island_folk`. Categories are only created this way: there is no
category file.

## Scripts

Put `.rs2` files anywhere under `scripts/`. Two mods can both have
`scripts/quest/start.rs2`. Every mod's scripts are compiled together with
base content, so mod scripts can call base procs, and base content can run
mod scripts through triggers.

Compiler errors show the path as
`data/pack/mods/scripts/<mod name>/<path under scripts/>`. The line numbers
are the same as in your file.

Useful patterns:

- A new npc, loc or obj gets scripts with the usual triggers:
  `[opnpc1,island_warden]`, `[oploc1,island_ferry]`, `[opheld1,my_item]`.
- A `[debugproc,name]` runs in game with `::~name` (see
  [Building, testing and debugging](#building-testing-and-debugging)). A
  debugproc has no protected access. To change varps or inventories, wrap the
  code in `if (p_finduid(uid) = true) { ... }`, as base cheats do.
- `[mapzone,<level>_<x>_<z>]` runs when a player enters map square x, z on
  that level.

### Script overrides

A mod script with the same `[trigger,subject]` as a base script replaces the
base script. Everything in base content that runs, calls or jumps to that
script now runs the mod's version.

```
// mods/MyQuest/scripts/hans.rs2
[opnpc1,hans]
if (%myquest = 1) {
    ~chatnpc("<p,neutral>The Duke? He went to Draynor.");
    return;
}
@original_opnpc1_hans;    // all other cases: the base dialogue
```

This works for every trigger: `[opnpc1,x]` to `[opnpc5,x]`, `[apnpc*]`,
`[oploc*]`, `[opobj*]`, `[opheld*]`, the `u` and `t` variants,
`[if_button,iface:com]`, `[if_close,x]`, `[inv_button*]`, `[proc,x]`,
`[label,x]`, `[queue,x]`, `[timer,x]`, `[softtimer,x]`, `[ai_*]`,
`[debugproc,x]`, `[login,_]`, `[logout,_]`, `[tutorial,_]`, `[mapzone,x]`,
`[zone,x]`, `[walktrigger,x]`, `[advancestat,x]`, `[changestat,_]` and so on.
It also works for scripts of an earlier mod.

Rules:

- **Keep the signature.** An override of `[proc,x](int $a)(int)` must have
  the same parameter types and return types. Base content still calls it.
  The build stops if they differ.
- **The same script twice in one mod** is an error.
- **Two mods override the same script:** the mod that loads later wins.
- `[command,x]` cannot be defined by mods.
- The build logs every override, for example
  `[mods] MyQuest overrides [opnpc1,hans] from base content (scripts/areas/area_lumbridge/scripts/hans.rs2:1); its original: @original_opnpc1_hans`.

### Calling the original

The script that you replace stays in the build under the name
`original_<trigger>_<subject>`. The subject is written as in the header, so
`_` stays: `[login,_]` gives `original_login__`, and `[opnpc1,_citizen]`
gives `original_opnpc1__citizen`.

| You replace | The original | Call it with |
| --- | --- | --- |
| `[opnpc1,hans]` | `[label,original_opnpc1_hans]` | `@original_opnpc1_hans;` |
| `[queue,foo](int $n)` | `[label,original_queue_foo](int $n)` | `@original_queue_foo($n);` |
| `[label,foo]` | `[label,original_label_foo]` | `@original_label_foo;` |
| `[if_button,logout:try_logout]` | `[label,original_if_button_logout:try_logout]` | `@original_if_button_logout:try_logout;` |
| `[login,_]` | `[label,original_login__]` | `@original_login__;` |
| `[proc,count_questpoints]()(int)` | `[proc,original_proc_count_questpoints]()(int)` | `~original_proc_count_questpoints` |
| `[logout,_]()(boolean)` | `[proc,original_logout__]()(boolean)` | `return(~original_logout__);` |

- The original of a **proc**, and of a script that returns a value
  (`[logout,_]`), is a proc. Call it with `~`. It returns, so your code after
  the call runs.
- The original of **any other script** is a label. Jump to it with `@` and
  give the same arguments. A jump does not return: code after it does not
  run. So check your own cases first, and jump to the original last.
- To run the original **and then continue**, call it with `~` instead of
  `@`. The build then makes a proc original. A proc cannot jump to labels,
  so this works only if the replaced script does not jump to labels. If it
  does, the build stops and tells you to use `@`. If you use both `~` and
  `@`, the build makes both.
- The original runs with your script's pointers (active player, npc, loc,
  obj, protected access). The compiler checks this. If your script changes
  the active npc or loc (for example with `npc_find`), call the original
  before that.
- Only the mod that overrides a script can use its original. A reference
  from another mod is an error.
- Names `original<number>_...` are internal. Do not use them.

### Two mods override the same script

Each mod's original is the version that this mod replaced. If ModA and ModB
(later in load order) both override `[opnpc1,hans]`, ModB's script runs.
`@original_opnpc1_hans` in ModB runs ModA's script, and
`@original_opnpc1_hans` in ModA runs the base script. So two quest mods can
both add dialogue to Hans, if each one jumps to its original for the cases
that it does not handle. In the build output, ModA's original is compiled
as `original1_opnpc1_hans` (a log line shows this).

### Type-specific scripts, categories and defaults

For npcs, locs and objs, the engine looks for a script in this order: the
type-specific script (`[opnpc1,man]`), then the category script
(`[opnpc1,_citizen]`, because `man` has `category=citizen`), then the
default script (`[opnpc1,_]`).

- To replace a category script or a default script, use its exact header:
  `[opnpc1,_citizen]` or `[opnpc1,_]`. This changes every subject in that
  category (or every subject without a script).
- A new type-specific script, such as `[opnpc1,man]` when base content has
  none, replaces nothing. But for `man` it runs instead of the category or
  default script. Other citizens are not affected. The build logs this.
- Its original is a copy of the script that would run without it:
  `@original_opnpc1_man` runs the body of `[opnpc1,_citizen]` (or of
  `[opnpc1,_]` if there is no category script).
- This works for the triggers whose subject is an npc, loc or obj:
  `opnpc1`-`5`, `apnpc1`-`5`, `opnpcu`, `apnpcu`, the same for `loc` and
  `obj`, `opheld1`-`5`, and the npc `ai_*` triggers (`ai_queue1`-`20`,
  `ai_timer`, `ai_spawn`, `ai_despawn`, `ai_opnpc1`, ...). It does not work
  for `opheldu` (it looks at two objs), the `t` (spell) triggers, player
  triggers, or scripts with a named subject (`proc`, `queue`, ...).
- If there is no category or default script, the original does not exist and
  the build stops.

### Script errors

```
[mod MyQuest] scripts/q.rs2:2: [proc,count_questpoints] must keep the signature ()(int) of base content (scripts/general/scripts/quests.rs2:57), found (int)(int)
[mod MyQuest] scripts/q.rs2:3: [proc,myquest_helper] does not replace an existing script, so ~original_proc_myquest_helper does not exist
[mod MyQuest] scripts/q.rs2:3: ~original_opnpc1_borderguard1 cannot be a proc: [opnpc1,borderguard1] in base content (...) jumps to labels (line 2). Jump to it with @original_opnpc1_borderguard1 instead
[mod MyQuest] scripts/q.rs2:3: the original of [proc,update_questlist] is a proc (the original of a proc): call it with ~original_proc_update_questlist
[mod Other] scripts/o.rs2:3: @original_opnpc1_hans is the original of a script this mod does not define; only a mod that overrides that script can call its original
```

Compiler errors in an original show the staged copy:
`data/pack/mods/overrides/base/<path under scripts/>` for a base file, or
`data/pack/mods/overrides/copies/...` for a copy. Line numbers are the same
as in the source file.

## Models and textures

### Units and axes (model space)

- 128 units = 1 tile.
- **y points down**: negative y is up.
- **The front of a model faces -z.**
- `bun run mod:art model <file.ob2 | base model name>` prints each label's
  vertex count, centre and bounds. Use it to find pivots for animations.

### .ob2 models

`models/**/<name>.ob2` is a model in the cache format. Configs refer to it by
name: `model=<name>` (locs, objs), `model1=<name>` (npcs). A base model name
(for example `model_2429_obj`) replaces that model. The later mod wins over
`.ob2` and `.obj` files alike.

### Models from OBJ

`models/**/<name>.obj` (with the `.mtl` file that `mtllib` names) is
converted to `.ob2` at build time.

- A new name gets a model id. A base model name replaces that model.
- Default scale is 128: 1 OBJ unit (1 Blender metre) = 1 tile. OBJ is y-up
  with the front facing +z. The converter turns that into the client's axes.
- **Groups pick vertex labels** (animations move vertices by label). Each
  `g <name>` (or `o <name>`) line gives the faces that follow a label:
  - from `"labels"` in the options file;
  - else from a bone of the same name in the `"rig"` animset (the bone's
    first label);
  - else from a name like `label_5` or `5`;
  - else 0.
  - With `labels` or `rig` set, a group without a label is an error.
- Vertices shared between groups are split, so the parts can move apart.
- **Materials (.mtl)**:
  - `Kd r g b` sets the colour.
  - `d` / `Tr` set transparency.
  - A material named `hsl_<n>` uses client colour n exactly.
  - `map_Kd <file>` textures the face with the texture whose name is the
    file's base name (a base or mod texture). Textured faces need UVs. The
    client does not repeat a texture across one face.
  - `s off` gives flat shading; `s 1` gives smooth.
- Polygons are fan-triangulated, so use convex polygons or triangulate on
  export.
- Front faces are counter-clockwise seen from outside (normal OBJ).

Options file `models/<name>.json` (all keys optional):

```json
{ "scale": 128, "rig": "critter", "labels": { "tail_tip": 3 }, "priority": 0, "faceLabels": false }
```

- `rig`: a bone-form animset name from any enabled mod (see
  [Animations](#animations)).
- `priority`: render priority of all faces, 0-11.
- `faceLabels`: also writes face labels and an alpha section, for alpha
  (fade) animations.

**Blender export settings**:

- File > Export > Wavefront (.obj), with the default axes (Forward -Z, Up Y).
- Enable **Vertex Groups**, Materials and UV Coordinates. Normals are ignored.
- Name your vertex groups after your bones and set `"rig"`.
- Blender writes each face under the vertex group that most of its vertices
  belong to. There is one label per vertex: there are no weights.

Check a conversion without a build: `bun run mod:art obj models/critter.obj`.

### Textures

`textures/**/<name>.png` is a texture. Base textures are 128 x 128 pixels. An
optional `meta/<name>.opt` next to the PNG holds a crop box
(`x,y,width,height`), as in `content/textures/meta/`.

- A new name gets a texture id after the 50 base textures. A base name (for
  example `bark`) replaces that texture.
- Models use textures through `map_Kd` in an OBJ material, and floors through
  `texture=<name>`.
- The Brumescape web client holds up to 256 textures (ids 0-255; base content
  uses 50). A texture that gets id 256 or higher stops the build. The ids that
  `idmap.json` keeps for disabled and removed mods count too.
- An id that `idmap.json` keeps for a mod that is not enabled gets a plain
  grey 64 x 64 placeholder texture, so the ids stay contiguous.

## Animations

Mods can add animations, override base animations, and animate OBJ models.

### Concepts

- A **vertex label** (0-255) is a number on every model vertex. An animation
  moves vertices by label.
- A **group** is one transform with a type and a list of labels.
- A **base** (skeleton) is the list of groups.
- A **frame** is one pose: values for some of the groups.
- An **animset** is one base plus its frames. It is the unit that the cache
  stores. One `anims/<set>.json` file is one animset.
- A **seq** config plays frames in order.

### Animation names, ids and overrides

- The file name is the animset name. Every frame has a `"name"`. Names use
  letters, digits and `_`.
- New names get stable ids after base content (in `mods/idmap.json`).
- **Frame names are global.** Seq configs refer to frames by name.
- Override a base animset: name the file after it, for example
  `anims/anim_8.json`. Frames you do not redefine are kept. The base is kept
  unless you give a new `"base"`. If you do, you must redefine every frame of
  the set.
- Override one base frame: define a frame named after it (for example
  `anim_4178`) in any of your sets. It keeps its id, so every base seq that
  uses it plays your version.
- Find the set that holds a frame: `bun run mod:art anim-find anim_4178`.
- Get a base set as JSON to edit: `bun run mod:art anim-unpack anim_13 anims/anim_13.json`.
- Binary `.anim` files are not accepted in mods. Convert them with
  `anim-unpack`.

### Form 1: bone form (easiest for new creatures)

```json
{
    "bones": [
        { "name": "body", "label": 1 },
        { "name": "head", "label": 2, "parent": "body", "pivot": [0, -40, -26] },
        { "name": "leg_fl", "label": 4, "parent": "body", "pivot": [12, -19, -18] }
    ],
    "delay": 5,
    "frames": [
        { "name": "critter_ready_1" },
        { "name": "critter_walk_1", "pose": { "leg_fl": { "rotate": [25, 0, 0] } } },
        { "name": "critter_walk_2", "delay": 4, "pose": {
            "body": { "translate": [0, -2, 0] },
            "head": { "rotate": [0, 90, 0] },
            "leg_fl": { "scale": [1, 1.5, 1] } } }
    ]
}
```

**Bones**

- `label` (one) or `labels` (several): the vertex labels the bone owns. A
  label can belong to only one bone.
- `parent`: optional. A child moves with its parent.
- `pivot`: the point in model units that the bone rotates and scales about.
  Without a pivot, the bone uses the centre of its own vertices.

**Pose values**

- `rotate`: [x, y, z] in degrees. x is pitch (nod), y is yaw (turn), z is
  roll. The client stores 256 steps per turn (about 1.4 degrees) and applies
  roll, then pitch, then yaw.
- `translate`: [x, y, z] in model units. Remember that y down is positive.
- `scale`: a number or [x, y, z], from 0 to 127 (1 = no change).

**Frames**

- Every frame is a full pose relative to the rest model, not to the previous
  frame. A frame with no `pose` is the rest pose.
- `delay` is in client ticks of 20 ms (0-255). A frame's own `delay`
  overrides the top-level `"delay"`.
- The client does not blend between frames.

### Form 2: base form (exact control, existing skeletons)

```json
{
    "base": { "groups": [
        { "name": "neck", "type": "origin", "labels": [] },
        { "name": "turn", "type": "rotate", "labels": [2] }
    ] },
    "delay": 4,
    "frames": [ { "name": "look_left", "transforms": [["neck", 0, -40, -26], ["turn", 0, 64]] } ]
}
```

**Group types and what [x, y, z] does**

- `origin`: sets the pivot to the centre of the group's labelled vertices
  plus (x, y, z). With no labels, the pivot is (x, y, z).
- `translate`: moves the labelled vertices by (x, y, z).
- `rotate`: rotates about the pivot. x = pitch, y = yaw, z = roll, in 256
  units per turn.
- `scale`: scales about the pivot. 128 = 1x.
- `alpha`: adds x*8 to the transparency of faces with these **face** labels
  (0 = opaque, 255 = invisible). The model needs `"faceLabels": true`.

**Transforms**

- A transform is `[group, x, y, z]`. The group is an index or a group name.
  Missing values are 0 (128 for scale). Values are whole numbers from -16384
  to 16383.
- The client applies transforms in group order, so put each origin before
  the groups that use it.

**Using an existing skeleton.** `"base"` can be a string instead of an
object:

- `"base": "base_13"`: the rat's skeleton.
- `"base": "anim_83"`: the skeleton of that base set.
- `"base": "<your animset>"`: a skeleton from any mod. Group names from a
  bone-form set work, for example `["body.translate", 0, -6, 0]`.

Use this to add frames for base npcs or for players. Find the skeleton with
`anim-find` on a frame of a similar base seq (player frames: for example
`anim_1555` is in `anim_83`), then `anim-unpack` that set to see its groups.

### Playing frames: seq and npc configs

```
[critter_walk]
frame1=critter_walk_1
frame2=critter_walk_2
// optional: overrides the frame's own delay
delay2=3

[critter]
model1=critter
readyanim=critter_ready
walkanim=critter_walk
```

`walkmerge=label_<n>,...` takes **group indices** of the base.
`bun run mod:art anim-check anims/<set>.json` prints the group indices,
names, and the exact transforms that the client applies per frame.

A complete working example (an OBJ model rigged to a bone-form set, seqs and
an npc) is in `tools/mod/fixtures/anims/anims_base/`.

## Interfaces and sprites

Mods can add new UI (quest journals, feature panels), change or replace base
interfaces, and add or replace 2D sprites.

```
mods/<mod>/
  interfaces/
    my_journal.if          # a new interface (or a whole replacement, if the name exists)
    questlist.ifpatch      # changes to an existing interface
  sprites/
    my_scroll.png          # a new sprite (or a replacement, if the name exists)
    meta/my_scroll.opt     # optional: crop box, or tile size + boxes for a sheet
    meta/my_scroll.pal.png # optional, rarely needed: fixed palette order
    icons/my_badge.png     # subfolders are fine; meta/ sits next to the .png
  scripts/journal.rs2      # scripts that open and update the interface
```

### Interface files (.if)

The syntax is the same as `content/scripts/**/interfaces/*.if`:

- Lines before the first `[section]` are the interface's own properties.
  Usually there are none, or `type=overlay` for a side-tab panel.
- Each `[component]` section is one component. Sections are drawn in file
  order.
- Blank lines and lines that start with `//` are ignored.

```
// interfaces/my_journal.if: a main-screen journal
[background]
type=graphic
x=0
y=0
width=512
height=334
graphic=my_scroll,0

[frame]
type=layer
x=40
y=40
width=430
height=250
scroll=600

[title]
layer=frame
type=text
x=0
y=0
width=430
height=20
center=yes
font=q8
text=My Quest
colour=0x800000

// y=end+4: 4 px below the previous component in the same layer
[entry1]
layer=frame
type=text
x=10
y=end+4
width=410
height=14
font=p12
text=I should talk to the guard.

[close]
type=graphic
x=470
y=10
width=16
height=16
buttontype=normal
option=Close
graphic=my_buttons,0
activegraphic=my_buttons,1
```

Component types: `layer`, `inv`, `rect`, `text`, `graphic`, `model`,
`invtext`. The common properties are:

| Property | Values |
| --- | --- |
| `x`, `y`, `width`, `height` | numbers. `y` also takes `end` or `end+N` |
| `layer` | parent layer: a `type=layer` component in the same interface |
| `buttontype` | `normal`, `target`, `close`, `toggle`, `select`, `pause` (or `none`) |
| `option` | the menu text of a button |
| `font` | `p11`, `p12`, `b12`, `q8` |
| `text`, `activetext` | Latin-1 text only |
| `colour`, `activecolour`, `overcolour`, `activeovercolour` | colours, e.g. `0xFF981F` |
| `center`, `shadowed`, `fill`, `hide` | `yes` / `no` |
| `graphic`, `activegraphic` | `<sprite>,<tile>` |
| `model`, `activemodel` | model names |
| `anim`, `activeanim` | seq names |
| `zoom`, `xan`, `yan` | numbers |
| `scroll` | the scroll height of a layer |
| `scriptN` / `scriptNopM` | client-side conditions, as in base content |
| `slotN`, `optionN`, `margin`, `draggable`, `interactable`, `usable`, `swappable`, `actionverb`, `action`, `actiontarget`, `clientcode`, `trans`, `overlayer` | as in base content |

Unknown properties, bad values and unknown sprites, models, seqs, varps or
objs stop the build with `[mod X] file:line: message`.

**Override rules for interfaces**

- **A new name** (`my_journal`) adds an interface. Mod scripts can use it at
  once: `if_openmain(my_journal)`, `if_settext(my_journal:title, "...")`,
  `[if_button,my_journal:close]`.
- **A base name** (or another mod's name) **replaces the whole interface.**
  - Interface properties that you do not set, such as `type=overlay`, are
    kept from the version that you replace.
  - Components that you leave out keep their ids as empty, hidden layers, so
    base scripts that use them still compile. The build lists them in a
    warning.
- When two mods replace the same interface, the later one in load order
  wins, and the build logs a warning.
- One mod must not define the same interface twice.

### Patch files (.ifpatch)

Name the file after the interface that you change. It can be a base
interface or another mod's interface.

- `[existing_component]` sets or overrides only the properties that you
  list.
- `[new_component]` appends a component, which is drawn on top. A new
  component needs `type=`.
- Lines before the first section change the interface's own properties.
- Patches apply after all whole-file definitions, mod by mod in load order.
  So a patch also applies on top of another mod's replacement.
- If two mods set the same property to different values, the later one wins,
  and the build logs a warning.
- A patch cannot remove a property or a component. To do that, replace the
  whole interface.
- `y=end+N` places a component N px below the lowest earlier component in
  the same layer. If that goes past the end of a scrolling layer, the layer's
  `scroll` height grows to fit it. So several mods can each add an entry to
  the same list without knowing about each other: the entries stack in load
  order.

### Adding a quest list entry

The quest list is the base interface `questlist`, a side-tab overlay. Its
entries are text components in the scrolling layer `com_0`. Add yours with a
patch:

```
// interfaces/questlist.ifpatch
[my_quest]
layer=com_0
type=text
x=10
y=end+2
width=130
height=14
buttontype=normal
font=p12
shadowed=yes
text=My Quest
colour=0xFF0000
```

The entry lands below the last entry, in the members section. To place it
anywhere else, patch the `y` of the existing entries. The entry is red when
the game starts. To colour it at login and count its quest points, override
two base procs, as shown in [Walkthrough: making a quest](#walkthrough-making-a-quest).
The same pattern adds a song to the music tab: see
[Area music and the music tab](#area-music-and-the-music-tab).

### Interface ids

- Interfaces and their components share **one flat id space**
  (`content/pack/interface.pack`). For example: `questlist` = 638 and
  `questlist:com_0` = 639. Component ids are not derived from the interface
  id.
- Every new interface and component name gets a stable id after base content
  (8143 and up). Base names keep their base ids, also in a replacement.
- The cache format allows ids up to 65279.

### Sprites

- Sprite names are lower-case letters, digits and `_`. Interfaces use them as
  `graphic=<name>,<tile>`.
- **A new name** adds a sprite to the media archive.
- **A base name** replaces that sprite. The base sprite names are the PNG
  files in `content/sprites`, for example:
  - `sideicons`: 13 tiles of 30x30
  - `mapfunction`: 49 tiles of 15x15 (map icons; a loc's `mapfunction=N` uses tile N)
  - `mapscene`, `headicons`, `hitmarks`, `staticons`, ...
- The title screen sprites are in `title/`, not here (see
  [Title screen](#title-screen)).

**`meta/<name>.opt`** has three forms:

1. **No .opt:** the whole image is one sprite. If you replace a base *sheet*
   without an .opt, the base tile size is kept: crop boxes are generated, so
   the image must be a whole number of tiles.
2. **A single image with a crop box:** one line, `x,y,width,height`.
3. **A sheet:** the first line is the tile size, `WxH`. Then add one crop
   box per tile, left to right and top to bottom, *or* only the tile-size
   line, and the boxes are generated from the image. Each box is relative to
   its tile. Width and height must be at least 1, and x and y must be 255 or
   less.

   ```
   16x16
   0,0,16,16
   1,1,14,14
   ```

**Transparency and colours**: a pixel is transparent when its alpha is below
128 or when its colour is exactly `#FF00FF`. Colours near `#FF00FF` stay
opaque (base sprites use purples such as `#A906ED`), so an anti-aliased edge
against a magenta background keeps a pink fringe: use an alpha channel
instead. A sprite has at most 254 colours, plus transparency. Larger images
are quantized automatically. The same rules apply to textures and the title
screen sprites.

**Limits**: the media index is limited to 64 KB. Base content uses about
7 KB, and each sprite adds about 3 bytes per colour plus 7 bytes per tile.
The client itself reads a fixed number of tiles from some base sheets:
`mapfunction` and `mapscene` 256 (with the Brumescape client), `sideicons`
13, `hitmarks` and `headicons` 20, `cross` 8 and `mod_icons` 2. A
replacement with more tiles gives a build warning: the extra tiles show only
in interfaces (`graphic=<name>,<index>`).

**Check your interfaces and sprites**:

```sh
bun run mod ui interface questlist          # every component, decoded
bun run mod ui component questlist:my_quest
bun run mod ui sprite my_scroll             # tiles, crops, colours
bun run mod:inspect sym component my_quest  # compiler symbols
```

## Title screen

| File | What | Size |
| --- | --- | --- |
| `title/logo.png` | The logo. | 444 x 142, like the base logo |
| `title/runes.png`, `title/titlebox.png`, `title/titlebutton.png` | The other title sprites (optional `title/meta/<name>.opt`). | Keep the base image sizes (`content/title/`). |
| `binary/title.jpg` | The background. | Same as `content/binary/title.jpg`. |

These always replace the base files. When two mods have the same file, the
later mod wins. The example mod `mods/brumescape` replaces the logo.

## Audio

| Path | What |
| --- | --- |
| `synth/**/*.synth` | Sound effects. Raw wave data in the same format as `content/synth/`. |
| `songs/**/*.mid` | Songs (standard MIDI files). |
| `jingles/**/*.mid` | Jingles (standard MIDI files). |

The file name without the extension is the asset name.

- **A new name** gets a stable id after the base ids (synth ids from 579,
  midi ids from 270). **A base name** (for example `bat_death.synth`, or
  `songs/scape_main.mid`) replaces the base file and keeps the base id. A
  song and a jingle must not share a name.
- Names: synth `a-z 0-9 _`; songs `a-z 0-9 _ -`; jingles also allow spaces.
  They must be lowercase. The build rejects other names.
- `.synth` files are checked with a port of the client decoder. A broken or
  truncated file stops the build. A `.mid` file must be a real MIDI file (it
  must start with `MThd`).
- **Play by name in scripts:**
  - `sound_synth(my_ping, 1, 0);` (synth names are compiler symbols)
  - `midi_song("my_theme");` (spaces become `_`, and the name is
    lowercased: `midi_song("My Theme")` also plays `my_theme`)
  - `midi_jingle("my_fanfare", 100);`
- The Brumescape client holds up to 65535 sounds (an unchanged 2004 client
  holds 1000, so about 420 mod sounds).

### Area music and the music tab

Base music works like this: a `[mapzone,<level>_<x>_<z>]` script calls
`@music_playbyregion(coord)`. That label finds the square's row in the
`musicregion` table (column `mapsquare`, value `<level>_<x>_<z>_0_0`) and
plays the song of the `music` row that it points to. A `music` row has the
song `name`, a `playbutton` (a component in the `music` interface) and an
optional `unlock` (a varp bit).

For a new area with a new song, give it all three parts:

```
// songs/island_theme.mid

// config/music.dbrow
[music_island_theme]
table=music
data=name,Island Theme
data=playbutton,music:island_theme

[musicregion_island_62_50]
table=musicregion
data=mapsquare,0_62_50_0_0
data=musicdata,music_island_theme

// interfaces/music.ifpatch: the button in the music tab
[island_theme]
layer=com_0
type=text
x=10
y=end+2
width=80
height=14
buttontype=normal
font=p12
shadowed=yes
text=Island Theme
colour=0x00FF00

// scripts/music.rs2
[mapzone,0_62_50] @music_playbyregion(coord);   // one line per map square of the area
[if_button,music:island_theme] ~music_playbybutton(music:island_theme);
```

- Without `data=unlock,...` the song is always unlocked, so the button is
  green (`colour=0x00FF00`). Base songs use `unlock` with the `musicmulti_*`
  varps and client scripts on the button. Mods cannot add bits to those
  varps safely, so leave `unlock` out.
- The simplest alternative is to play the song directly:
  `[mapzone,0_62_50] midi_song("island_theme");`.
- A `musicregion` row can also point at a base `music` row
  (`data=musicdata,music_Adventure`).

## spawns.json

```json
{
    "npcs": [{ "id": "jemery_mclabe", "coord": "0_50_50_32_32" }],
    "locs": [{ "id": "olive_oil_barrel", "coord": "0_50_50_34_32", "shape": 10, "angle": 0 }],
    "objs": [
        { "id": "coins", "coord": "0_50_50_30_30", "count": 100 },
        { "id": "bronze_sword", "coord": "0_50_50_30_31", "respawn": 50 },
        { "id": "bronze_dagger", "coord": "0_50_50_30_32", "respawn": false }
    ]
}
```

`coord` is `level_mapsquareX_mapsquareZ_localX_localZ` (the same numbers as
`::tele`). Use names, not ids. The build checks every entry and stops on an
unknown name or a bad value, for example
`[mod MyMod] spawns.json:4: objs[1]: unknown obj 'no_such_obj'`.

| Section | Keys | What the server does at start |
| --- | --- | --- |
| `npcs` | `id`, `coord` | Spawns the npc. It respawns after death (the npc's `respawnrate`). |
| `locs` | `id`, `coord`, `shape` (default 10), `angle` (default 0) | Adds a permanent loc. The server sends it to each player, because it is not in the client's map data. For scenery that belongs to the map, use a map square or a patch: those locs are part of the map. |
| `objs` | `id`, `coord`, `count` (default 1), `respawn` (default `true`) | `true`: when someone takes the obj, it comes back after the obj's `respawnrate` ticks (default 100 ticks, one minute), like objs in map squares. A number: it comes back after that many ticks. `false`: it spawns once per server start and does not come back. |

On a free-to-play world (`NODE_MEMBERS=false`), the server does not spawn
npcs and objs outside free-to-play zones, or members npcs and objs.

## Maps and new lands

A mod can:

- add a new map square where base content has none,
- replace a base map square as a whole,
- patch a square (base content or another mod's): change single tiles, and
  add or remove locs, npcs and objs. The rest of the square does not change,
- add zones to, or remove zones from, the free-to-play and multi-combat
  lists.

### Map squares and coordinates

The world is a grid of map squares. A square is 64 x 64 tiles on 4 levels
(level 0 is the ground). Square `m60_50` covers the tiles x 3840-3903
(60 x 64) and z 3200-3263 (50 x 64). Inside a square, a tile is
`<level> <x> <z>`, with x and z 0-63.

- Base content uses mostly squares x 29-55 and z 44-76 above ground.
  Dungeons are at z + 100 (z 144-161). Squares east of x 55 are unused. Run
  `bun run mod map grid` to see which squares are in use.
- Square x and z must be 0-255, with no leading zeros in file names.
- Do not use squares x 47-50, z 47-49, or 48_148: the client handles the
  tutorial island there in a special way.
- In game, `::tele 0,60,50,32,32` takes you to tile (32,32) of `m60_50` on
  level 0.

### Map files

```
MyMod/
  maps/
    m60_50.jm2          a whole square: new, or it replaces base m60_50
    m50_50.patch.jm2    a patch for an existing square
    free2play.csv       free-to-play zones to add or remove
    multiway.csv        multi-combat zones to add or remove
```

You can put `.jm2` files in subfolders of `maps/`. The two `.csv` files must
be directly in `maps/`. Any other file name in `maps/` stops the build.

### Start a square

```sh
bun run mod map new MyMod m60_50 --water 3 --free   # flat grassland island, free-to-play
bun run mod map copy MyMod m50_50                   # copy base m50_50 into the mod to replace it
bun run mod map patch MyMod m50_50                  # an empty patch with instructions
bun run mod map grid                                # which squares are in use
```

Options for `map new`:

- `--underlay <floor>`: the ground floor (default `grassland`). Mod floors
  from any installed mod's `.flo` files work too.
- `--overlay <floor>`: paint all land tiles with this floor.
- `--height flat|perlin|<1-255>`: default `flat`; `perlin` gives rolling hills.
- `--water <n>`: a border of n blocked water tiles.
- `--free`: add the square to `maps/free2play.csv`.
- `--force`: overwrite the mod's file if it exists.

### The .jm2 format

```
// comments start with //
==== MAP ====
0 0 0: h1 owater f1 ugrassland
0 10 10: h1 ugrassland
0 11 10: h12 oroad;1;2 ugrassland
==== LOC ====
0 30 30: oaktree              // <loc> [shape] [angle]
0 31 30: bankbooth 10 1
==== NPC ====
0 32 32: man                  // <npc>
==== OBJ ====
0 33 32: coins 25             // <obj> [count]
```

Every line is `<level> <x> <z>: ...`. Sections can come in any order. A
section can be empty or left out.

**MAP** lines define tiles. A tile that is not listed has no floor and gets
perlin-noise height. Tokens:

| Token | Meaning |
| --- | --- |
| `h<n>` | Height, 1-255. `h1` is flat at ground level. No `h`: perlin noise (natural hills that fit the squares around it). |
| `u<floor>` | Underlay: the ground colour, blended with the tiles around it (`ugrassland`, `usand`, `umud1`, or a mod floor such as `uisland_moss`). |
| `o<floor>[;shape[;rotation]]` | Overlay: a floor on top (`owater`, `oroad`, `owoodenfloor`, `oisland_path`). Shape 0-11 (0 is the full tile, the others cover part of it), rotation 0-3. |
| `f<n>` | Flags, added together: 1 blocks the tile (use it for water), 2 links the tile to the level below (bridges), 4 removes roofs, 8 makes it visible from below, 16 hides it in low detail. |

Base floors are in `content/scripts/floors/underlay.flo` and `overlay.flo`.
Mod floors come from [`.flo` configs](#floors).

**LOC**: `<loc> [shape] [angle]`.

- Shape (default 10): 0-3 walls, 4-8 wall decoration, 9 diagonal wall, 10
  normal object, 11 diagonal object, 12-21 roofs, 22 ground decoration.
- Angle (default 0): 0 west, 1 north, 2 east, 3 south.
- Locs in a map square are part of the client's map: the client renders them
  with the map, and the server adds their collision.

**NPC**: `<npc>`. The npc spawns there and respawns after death.

**OBJ**: `<obj> [count]`. Count 1-255 (default 1). When someone takes the
obj, it comes back after the obj's `respawnrate`.

**Names and numbers.** Write locs, npcs, objs and floors **by name**. Base
content files use numbers, and you can use numbers for base content too (a
copied base square keeps them). A numeric floor is the floor id + 1: `u48` is
floor id 47, `grassland`. Never use a number for something that a mod
defines: the build warns when a number belongs to mod content. A new square
gets ids for its two map files (land and locs) in `idmap.json`, under `map`.

### Patches

A patch (`m50_50.patch.jm2`) changes an existing square and keeps
everything else:

```
==== MAP ====
0 20 20: h1 omarble ugrassland    // replaces the whole tile (20,20)
==== LOC ====
-0 17 41: tree                    // removes the tree at (17,41)
0 17 41: my_statue 10 2           // and puts a statue there
==== NPC ====
-0 0 38: giantspider1
==== OBJ ====
-0 5 27: *                        // removes every obj on that tile
0 5 28: coins 50
```

- A MAP line replaces all of that tile's terrain. `0 5 5:` with no tokens
  makes the tile empty.
- LOC, NPC and OBJ lines add entries.
- A line that starts with `-` removes the entries on that tile with that id
  (`*` means any id). To remove only exact matches, also give the shape and
  angle (for locs) or the count (for objs).
- Removals run before additions, so you can remove and add on the same tile.
- A removal that matches nothing stops the build, for example
  `[mod MyMod] maps/m50_50.patch.jm2:3: '-0 10 10: man' matches no npc in the square`.
  This usually means that base content or another mod changed the square.

### Which mod wins

- Mods are applied in load order.
- A whole square (`m60_50.jm2`) replaces the square as it is at that point:
  base content or an earlier mod's square. When two mods have the same whole
  square, the later mod wins and the build logs a warning. Patches from
  earlier mods for that square are dropped, with a warning.
- Patches apply in load order, on top of the square as it is at that point.
  A patch for a square that another mod adds must load after that mod: put
  that mod in `dependencies`. A patch for a square that does not exist stops
  the build.
- One mod cannot have the same square twice (two whole files, or two
  patches). One whole file and one patch for the same square in one mod is
  allowed: the patch applies after the whole file.

### Free-to-play and multi-combat zones

A zone is 8 x 8 tiles. `maps/free2play.csv` and `maps/multiway.csv` list
zones to add to the base lists, or to remove from them:

```
// <level>_<squareX>_<squareZ>                     the whole square (64 zones)
0_60_50
// <level>_<squareX>_<squareZ>_<localX>_<localZ>    one zone; localX and localZ are 0, 8, ... 56
0_60_50_24_24
// a '-' removes zones, e.g. to make a free-to-play base zone members-only
-0_50_50_0_0
```

- A new square is members-only until you add it to `free2play.csv`. On a
  free-to-play world (`NODE_MEMBERS=false`), the server does not load
  members squares: no collision, npcs or objs, and players cannot walk
  there. The client also uses the list to decide which squares a
  free-to-play player downloads in advance.
- Only level 0 counts for free-to-play. Multi-combat zones are per level.
- The build writes the merged lists to `data/pack/server/free2play.csv` and
  `multiway.csv`. When no mod has these lists, the server reads the base
  ones.

### Check your square

- The build logs each square that mods touch, for example
  `[mods] maps: m60_50 (new square from MyMod): 4096 tiles, 3 locs, 2 npcs, 1 objs`.
- At start, the server logs what it loaded, for example
  `[mods] maps: m60_50 (new square, MyMod): 256 zones with collision, 746 blocked tiles, 5 locs, 4 objs, 3 npcs`.
- `bun run mod:inspect map m60_50 0 30 30` shows a packed square and one
  tile, as the client and the server get them.
- The server loads maps only when it starts. After a rebuild, restart the
  server to see map changes.

### World map

`bun run tools/pack/map/Worldmap.ts` (after a build) draws the world map with
mod squares and the merged zone lists. The engine does not serve
`worldmap.jag`, and the client's map viewer shows only squares x 36-55,
z 44-62. Floors that mods add are black on the world map.

## Walkthrough: making a new land

This walkthrough makes an island in an unused map square, with its own
floors, an npc, a way to get there and its own music. Every part of it is
also in the engine's `integration` test fixture
(`tools/mod/fixtures/integration/int_land/`), which the build checks.

**1. Create the mod.**

```sh
bun run mod create MyIsland --author you --description "A small island east of Lumbridge"
```

**2. Choose a square.** Run `bun run mod map grid`. Choose a square that base
content and other mods do not use, away from the tutorial island (see
[Map squares and coordinates](#map-squares-and-coordinates)). This
walkthrough uses `m62_50`.

**3. Add floors** (optional, see [Floors](#floors)). Base floors are often
enough.

```
// mods/MyIsland/config/island.flo
[island_moss]
colour=0x2E5A2A

[island_path]
overlay=yes
colour=0x7A5C3A
```

**4. Make the square.**

```sh
bun run mod map new MyIsland m62_50 --underlay island_moss --water 3
```

This writes `maps/m62_50.jm2`: 64 x 64 flat tiles of `island_moss` with a
3-tile water border. Edit it (see [The .jm2 format](#the-jm2-format)): add a
path (`0 32 30: h1 oisland_path uisland_moss`), hills (`h<n>`), trees and
buildings in `==== LOC ====` (`0 28 28: tree`) and npcs in `==== NPC ====`.
Add `--free` or a line `0_62_50` in `maps/free2play.csv` to make the island
free-to-play (see [Zones](#free-to-play-and-multi-combat-zones)).

**5. Add an npc.** Define it in `config/` (see [Configs](#configs)), place it
in the square, and give it a script:

```
// config/island.npc
[island_warden]
name=Island warden
desc=Keeps an eye on the island.
model1=model_215_idk
model2=model_246_idk
model3=model_292_idk
model4=model_151_idk
model5=model_176_idk
model6=model_254_idk
model7=model_181_idk
head1=model_53_idk_head
walkanim=human_walk_f,human_walk_b,human_walk_l,human_walk_r
readyanim=human_ready
op1=Talk-to

// maps/m62_50.jm2
==== NPC ====
0 33 33: island_warden

// scripts/island.rs2
[opnpc1,island_warden]
~chatnpc("<p,neutral>Welcome to the island.");
```

For a new creature with its own model and animations, see
[Models from OBJ](#models-from-obj) and [Animations](#animations).

**6. Add a way to get there.** A loc on the mainland with a teleport script.
Place it with [spawns.json](#spawnsjson), or as part of the map with a
[patch](#patches) of the mainland square:

```
// config/island.loc
[island_ferry]
name=Ferry
desc=It goes to the island.
model=model_loc_63
op1=Board

// spawns.json
{ "locs": [{ "id": "island_ferry", "coord": "0_50_50_20_20" }] }

// scripts/island.rs2
[oploc1,island_ferry]
mes("You board the ferry.");
p_telejump(0_62_50_32_31);
```

**7. Give it music** (see [Area music and the music tab](#area-music-and-the-music-tab)):
put a song in `songs/island_theme.mid`, add the `music` and `musicregion`
rows, the music tab button (`interfaces/music.ifpatch`) and the two script
lines (`[mapzone,0_62_50]` and `[if_button,music:island_theme]`).

**8. Build and visit.**

```sh
bun run mod validate MyIsland      # stops on the first mistake, with file and line
bun run build && bun run quickstart
```

The build log lists the floors (`[mods] floor island_moss: flo id 89 ...`)
and the square (`[mods] maps: m62_50 (new square from MyIsland) ...`). Log in
and type `::tele 0,62,50,32,32`. Restart the server after every map change.
`bun run mod:inspect map m62_50 0 32 30` shows what the client and the server
get for one tile.

## Walkthrough: making a quest

Base quests use plain content: a progress varp, constants, a quest list
entry and scripts. Two base procs list every quest by hand:
`[proc,update_questlist]` colours the quest list at login, and
`[proc,count_questpoints]` counts quest points. A quest mod overrides them
and calls their originals, so several quest mods can be installed together.
Every part of this walkthrough is also in the engine's `integration` test
fixture (`tools/mod/fixtures/integration/int_quest/`).

| File in the mod | What it does | Section |
| --- | --- | --- |
| `mod.json` | The mod, with `dependencies` if the quest uses another mod's land or npcs. | [mod.json](#modjson) |
| `config/myquest.constant` | The final stage and the quest points. | [Constants](#constants) |
| `config/myquest.varp` | The progress varp, saved with the player. | [Configs](#configs) |
| `config/*.npc`, `*.obj`, `*.loc` | New quest npcs, items and scenery. | [Configs](#configs) |
| `config/patch/*.npc`, ... | Small changes to existing configs, such as an extra option on a base npc. | [Config patches](#config-patches) |
| `interfaces/questlist.ifpatch` | The quest's entry in the quest list. | [Adding a quest list entry](#adding-a-quest-list-entry) |
| `scripts/myquest.rs2` | Dialogue, progress, completion, and the two quest list procs. | [Scripts](#scripts), [Script overrides](#script-overrides) |
| `spawns.json` or a map | Where the quest npcs and items are. | [spawns.json](#spawnsjson), [Maps](#maps-and-new-lands) |
| optional | A jingle, a journal interface, data tables. | [Audio](#audio), [Interfaces](#interfaces-and-sprites), [Data types](#data-types-constants-tables-floors-categories) |

**1. Create the mod.** `bun run mod create MyQuest`. If the quest happens on
another mod's land (for example the island from
[the land walkthrough](#walkthrough-making-a-new-land)), add that mod to
`dependencies` in `mod.json`.

**2. Progress varp and constants.** The varp must have `scope=perm`, or the
progress is lost at logout. It gets a save-safe id (see
[Stable ids and player saves](#stable-ids-and-player-saves)).

```
// config/myquest.varp
[myquest]
scope=perm

// config/myquest.constant
^myquest_complete = 2
^myquest_questpoints = 1
```

**3. Items and npcs.** New configs in `config/`. To give a base npc (or
another mod's npc) a new option, use a patch:

```
// config/myquest.obj
[myquest_token]
name=Island token
desc=The warden asked for this.
model=model_2429_obj
2dzoom=1410
2dxan=400
2dyan=368

// config/patch/warden.npc
[island_warden]
op3=Ask-about-quest
```

**4. The quest list entry.** See
[Adding a quest list entry](#adding-a-quest-list-entry):

```
// interfaces/questlist.ifpatch
[myquest]
layer=com_0
type=text
x=10
y=end+2
width=130
height=14
buttontype=normal
font=p12
shadowed=yes
text=My Quest
colour=0xFF0000
```

**5. Dialogue and progress.** A new npc gets its own script. For an npc that
already has a script (from base content or another mod), override it and jump
to the original for the cases that your quest does not handle (see
[Calling the original](#calling-the-original)):

```
// scripts/myquest.rs2
[opnpc1,island_warden]
if (%myquest = 0) {
    ~chatnpc("<p,neutral>Bring me an island token.");
    %myquest = 1;
    ~send_quest_progress(questlist:myquest, %myquest, ^myquest_complete);
    return;
}
if (%myquest = 1 & inv_total(inv, myquest_token) > 0) {
    inv_del(inv, myquest_token, 1);
    queue(myquest_complete, 0);
    return;
}
@original_opnpc1_island_warden;     // everything else: the npc's normal dialogue

[opnpc3,island_warden]
~send_quest_progress(questlist:myquest, %myquest, ^myquest_complete);
```

`~send_quest_progress` colours the entry (red: not started, yellow: started,
green: complete) and opens the quest tab.

**6. Completion.**

```
[queue,myquest_complete]
%myquest = ^myquest_complete;
~send_quest_complete(questlist:myquest, myquest_token, 250, ^myquest_questpoints, "You have completed My Quest!");
```

`~send_quest_complete` plays a quest jingle, opens the quest scroll with the
item model and the message, updates `%qp` through `[proc,count_questpoints]`
and colours the entry green. Add rewards (`stat_advance`, `inv_add`) before
it.

**7. Login colour and quest points.** Override the two base procs and call
their originals. This works when several quest mods do the same: each one
calls the version that it replaced (see
[Two mods override the same script](#two-mods-override-the-same-script)).

```
[proc,update_questlist]
~original_proc_update_questlist;
~send_quest_progress_colour(questlist:myquest, %myquest, ^myquest_complete);

[proc,count_questpoints]()(int)
def_int $points = ~original_proc_count_questpoints;
if (%myquest = ^myquest_complete) {
    $points = add($points, ^myquest_questpoints);
}
return($points);
```

**8. Place the quest npcs and items** with [spawns.json](#spawnsjson) or in a
map square:

```json
{ "objs": [{ "id": "myquest_token", "coord": "0_62_50_30_30" }] }
```

**9. Test it.** A debugproc to set the stage saves time (a debugproc has no
protected access, so use `p_finduid`):

```
// ::~myquest_stage 1
[debugproc,myquest_stage](int $stage)
if (p_finduid(uid) = true) {
    %myquest = $stage;
    ~send_quest_progress(questlist:myquest, %myquest, ^myquest_complete);
}
```

Then `bun run mod validate MyQuest`, `bun run build`, `bun run quickstart`,
and play it. The build log shows the overrides, for example
`[mods] MyQuest overrides [proc,update_questlist] from base content (...); its original: ~original_proc_update_questlist`.

**Optional extras**:

- The enum `quest_names_enum` lists base quests for the debug `::quest`
  cheat. Add your quest with a patch: `[quest_names_enum]` and
  `val=<next free number>,My Quest`.
- A quest journal: a new interface (see [Interface files (.if)](#interface-files-if))
  opened from `[if_button,questlist:myquest]` with `if_openmain`. The
  questlist is an overlay, so this script runs without protected access.
- Your own jingle: `jingles/myquest_done.mid` and
  `midi_jingle("myquest_done", <length in ms>)` instead of the random base
  jingle.

## Building, testing and debugging

### Build

- `bun run build` packs base content and every enabled mod. When any file of
  an enabled mod changes, a mod is added, removed, enabled or disabled, or
  `idmap.json` changes, the next build repacks everything mods can affect.
  So removed content really disappears.
- `bun run mod validate <name>` builds base content plus only that mod and
  its dependencies. It uses a copy of `idmap.json`, so it never changes your
  ids. Afterwards, `data/pack` holds that build: run `bun run build` again.
- The dev server (`bun start` or `bun run quickstart` without
  `NODE_PRODUCTION`) watches `mods/` and rebuilds on change, like it does
  for content. Maps, zone lists and new songs are loaded only when the server
  starts, so restart it after you change them.
- `BUILD_MODS_DIR=<dir>` builds or runs with a different mods folder.
- `BUILD_VERIFY=true` still checks base content against its checksums. It
  skips, with an info line, the types that mods change.

### Read the build log

Every `[mods]` line tells you what a mod did: `Registered <kind> <name> (ID: n)`
for a new name, `... replaces base ...`, `... overrides [trigger,subject] ...`,
`... patches ...`, `maps: ...`, and a `WARN` when a later mod wins over an
earlier one. Errors start with `[mod <name>] <file>:<line>:`. The build stops
on the first error.

### Test in game

- `bun run quickstart` starts the server. When it prints `World ready`, open
  `http://localhost/` (on Linux `http://localhost:8888/`; `WEB_PORT` changes
  it) and log in.
- When `NODE_PRODUCTION` is false (the default), every player is a developer:
  - `::tele <level>,<squareX>,<squareZ>,<localX>,<localZ>` teleports, for
    example `::tele 0,62,50,32,32`.
  - `::~<name> [args]` runs `[debugproc,<name>]`. The starter script of
    `bun run mod create` has one.
- At start the server logs what mods placed, for example
  `[mods] MyMod: spawned 1 npc(s), 0 loc(s), 2 obj(s)`,
  `[mods] maps: m62_50 (new square, MyIsland): ...` and
  `[mods] Ran init for MyMod`.

### Inspect the build output

```sh
bun run mod:inspect order                      # mods in load order
bun run mod:inspect config npc island_warden   # the packed config, decoded
bun run mod:inspect script island              # compiled scripts whose name contains "island"
bun run mod:inspect sym component myquest      # compiler symbols
bun run mod:inspect ids flo                    # ids from idmap.json
bun run mod:inspect map m62_50 0 32 30         # a packed map square and one tile
bun run mod ui interface questlist             # an interface, decoded
bun run mod:art model model_2429_obj           # a base model's (or an .ob2 file's) labels and bounds
```

### The web client

The engine serves the Brumescape web client (`public/client/`, built from
`Brumescape_Client-TS`). It raises some 2004 limits that mods can reach:
textures (256 instead of 50), sounds (65535 instead of 1000), `mapfunction`
and `mapscene` tiles (256 instead of 50), and animation frame ids above
32767. Other clients work as long as a mod stays under the old limits.

### Fixtures (for engine developers)

`tools/mod/fixtures/` holds test mods for every capability. A fixture is a
mods folder plus a `check.ts` that reads the build output back, or an
`expect-fail.txt` with the errors that the build must print. An optional
`seed-idmap.json` is copied to the fixture's `idmap.json` before each build,
for fixed ids (for example an id kept for a disabled mod).

```sh
bun run mod:fixture integration           # one fixture
bun run mod:fixture integration empty     # then a build without mods: removal works
bun run mod:fixture --all                 # every fixture
bun run build                             # build the real mods/ again afterwards
```

## Tools reference

| Command | What it does |
| --- | --- |
| `bun run mod` | Interactive menu. |
| `bun run mod list` | Mods in load order, and disabled mods. |
| `bun run mod create [<name>] [--author a] [--description d] [--version v]` | Scaffold a mod. |
| `bun run mod enable <name>`, `disable <name>` | Edit `mods/mods.json`. |
| `bun run mod validate <name>` | Build base content plus one mod and its dependencies. |
| `bun run mod map new\|copy\|patch <mod> <square>`, `map grid` | Map squares (see [Start a square](#start-a-square)). |
| `bun run mod art <command>` or `bun run mod:art <command>` | `obj`, `model`, `anim-unpack`, `anim-check`, `anim-find`, `selftest`: models and animations. |
| `bun run mod inspect <command>` or `bun run mod:inspect <command>` | Read back the last build. |
| `bun run mod ui interface\|component\|sprite <name>` | Decoded interfaces and media sprites. |
| `bun run mod:fixture <name> \| --all` | Build and check test fixtures. |

`mod:art` commands:

- `obj <in.obj> [out.ob2] [--rig f.json] [--labels a=1,b=2] [--scale n] [--priority n] [--face-labels]`:
  convert and print the result (labels, centres, colours).
- `model <file | base name>`: summary of a model.
- `anim-unpack <anim_N | file.anim> [out.json]`: base-form JSON of a set.
- `anim-check <file.json>`: validate, and print groups and per-frame transforms.
  It resolves a `"base"` name against base content only (the build also
  resolves mod animsets).
- `anim-find <frame>`: which base set holds a frame.
- `selftest`: codec round trips on base content.

## Limits and known gaps

**Not yet seen in a running game.** Every capability is checked by decoding
the build output with the engine's and the web client's own decoders, and
the server starts with every capability's test mods. But no one has yet
played a mod in a browser: rendering, sounds, clicks and dialogue of mod
content are not confirmed in game.

Format limits:

- Ids are numbered after base content. Mods must not use high id ranges.
- Floors: underlay flo ids up to 173 and overlay up to 254 (about 85 new
  underlay floors across all mods). A floor texture id must be 255 or less.
- Textures: 256 in the Brumescape client (ids 0-255, 50 used by base
  content). The build stops at id 256.
- Models: at most 4096 vertices and 4096 faces (keep it under 2000 faces),
  and at most 255 texture mappings. Vertex labels 0-255.
- Animations: a base has at most 255 groups, a group at most 255 labels.
  Frame ids go up to 65534. No blending between frames, no vertex weights.
  The bone form cannot express alpha (fade) groups: use the base form.
- Interfaces: ids up to 65279. Latin-1 text only. Only the four base fonts.
- Sprites: the media index is limited to 64 KB.
- Sounds: 65535 in the Brumescape client.

Things mods cannot do yet:

- **Script overrides**: `@original_...` is a jump, so code after it does not
  run. `~original_...` runs the original and returns, but only for scripts
  that do not jump to labels. Most npc dialogue scripts jump to labels, so you
  cannot run code after their original.
- Type-specific originals (a new `[opnpc1,man]` reaching `[opnpc1,_citizen]`)
  do not work for `opheldu`, spell (`t`) triggers or player triggers.
- **Interface patches** cannot remove properties or components, and new
  components are always appended (drawn on top). A whole replacement keeps
  left-out components as empty hidden layers.
- **Maps** load only at server start. Patch removals match by tile and id, so
  a patch cannot remove one of two identical entries on the same tile. The
  `map new` scaffold makes level 0 only, with a uniform floor.
- **Categories** come only from `category=` in a mod npc, obj or loc.
- **Music**: mod songs cannot use the base `unlock` bits.
- **Removing a mod** does not clean player saves (see
  [Stable ids and player saves](#stable-ids-and-player-saves)).
- The world map tool and the client's map viewer show only part of the world
  (see [World map](#world-map)).
- Hot rebuilds with a running dev server are tested only for configs and
  scripts. Windows paths are not tested.
