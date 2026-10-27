# Writing Brumescape mods

A mod is a folder in `mods/` with a `mod.json`. The build (`bun run build`,
or the dev server's watcher) packs every enabled mod into the cache and the
server data together with base content. Mods never change the content repo.

For how the loader works inside, see [`src/mod/README.md`](../src/mod/README.md).

## Quick start

```sh
bun run mod create            # scaffold mods/<name>/ (interactive)
bun run build                 # pack base content + mods
bun run quickstart            # start the server
```

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
| `name` | yes | Identity of the mod: letters, digits, `_`, `-`, `.`. It must be unique. Load order, dependencies and `mods.json` use it. |
| `version` | yes | Shown in the build log. |
| `author`, `description` | no | Information only. |
| `dependencies` | no | `{ "<mod name>": "<version>" }`. Each listed mod must be installed and enabled. It loads before this mod. Versions are not checked yet. |
| `init` | no | A proc name. `[proc,<init>]` runs once on every server boot, after the map loads. |

## Enable, disable, load order

- `mods/mods.json` turns mods off without deleting them:
  `{ "disabled": ["MyMod"] }`. If the file does not exist, every mod is
  enabled.
- `bun run mod list` shows the load order. `bun run mod disable MyMod` and
  `bun run mod enable MyMod` edit `mods.json`. Rebuild after a change.
- Load order: mods sorted by `name` (uppercase letters sort before
  lowercase), then each mod moves after its dependencies. A missing or
  disabled dependency, or a dependency cycle, stops the build.

## Folder layout

All folders are optional. Subfolders are allowed everywhere except `title/`
and `binary/`.

| Path in the mod | Contents |
| --- | --- |
| `config/**/*.npc` `.obj` `.loc` `.seq` `.spotanim` `.idk` `.enum` `.struct` `.hunt` `.mesanim` `.varp` `.varn` `.vars` `.param` `.inv` | Configs. Same syntax as base content: `[name]` and then `key=value` lines. |
| `scripts/**/*.rs2` | RuneScript. |
| `models/**/<name>.ob2` | Models. Configs refer to them by name, e.g. `model=<name>`. |
| `textures/**/<name>.png` | Textures (optional `meta/<name>.opt`). |
| `title/logo.png`, `title/runes.png`, `title/titlebox.png`, `title/titlebutton.png` | Title screen sprites (optional `title/meta/<name>.opt`). Keep the base image sizes. The base logo is 444x142. |
| `binary/title.jpg` | Title screen background. |
| `spawns.json` | NPCs, locs and objs placed in the world when the server boots. |
| `maps/**/m<x>_<z>.jm2`, `maps/**/m<x>_<z>.patch.jm2` | Map squares: new squares, replacements, patches. |
| `maps/free2play.csv`, `maps/multiway.csv` | Zones to add to or remove from the free-to-play and multi-combat lists. |

## Names, ids and overrides

- **A new name** (one that base content does not use) gets a stable id. The
  id is saved in `mods/idmap.json`. **Commit `idmap.json` and never delete
  it**: player saves store ids. If you delete it, items, varps and so on can
  get different ids, and old saves then point at the wrong things.
- **A base name replaces the base entry**: a `[hans]` npc config, a
  `model_2429_obj.ob2` model, a `bark.png` texture, a `title/logo.png`. A
  config is replaced as a whole, so give every key you need.
- **When two mods use the same name, the mod that loads later wins.** The
  build logs a warning that names both mods.
- **The same name twice in one mod** is an error.
- **Scripts**: a `[trigger,subject]` that base content or another mod already
  defines is an error. Script overrides are not supported yet.

## Configs

Mod configs use the same parser as base content, and the build stops on the
first mistake with the mod, file and line:

```
[mod MyMod] config/npcs/guard.npc:7: Invalid property value: hitpoints=lots
```

You can use base constants (`^name`) and refer to base or mod names (models,
params, categories that base content defines, and so on).

## Scripts

Put `.rs2` files anywhere under `scripts/`. Two mods can both have
`scripts/quest/start.rs2`. Every mod's scripts are compiled together with
base content. Compiler errors show the path as
`data/pack/mods/scripts/<mod name>/<path under scripts/>`.

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
`::tele`). Names only, no ids. The build checks every entry and stops on an
unknown name or a bad value, for example
`[mod MyMod] spawns.json:4: objs[1]: unknown obj 'no_such_obj'`.

| Section | Keys | What the server does at start |
| --- | --- | --- |
| `npcs` | `id`, `coord` | Spawns the npc. It respawns after death (the npc's `respawnrate`). |
| `locs` | `id`, `coord`, `shape` (default 10), `angle` (default 0) | Adds a permanent loc. The server sends it to each player, because it is not in the client's map data. For scenery that belongs to the map, use a map square or a patch (below): those locs are part of the map. |
| `objs` | `id`, `coord`, `count` (default 1), `respawn` (default `true`) | `true`: the obj comes back after someone takes it, after the obj's `respawnrate` ticks (default 100 ticks, one minute), like objs in map squares. A number: comes back after that many ticks. `false`: spawns once per server start and does not come back. |

On a free-to-play world (`NODE_MEMBERS=false`), npcs and objs outside
free-to-play zones, and members npcs and objs, are not spawned.

## Maps and new lands

A mod can:

- add a new map square where base content has none,
- replace a base map square as a whole,
- patch a square (base content or another mod's): change single tiles, and
  add or remove locs, npcs and objs. The rest of the square stays as it is,
- add zones to, or remove zones from, the free-to-play and multi-combat lists.

### Map squares and coordinates

The world is a grid of map squares. A square is 64 x 64 tiles on 4 levels
(level 0 is the ground). Square `m60_50` covers the tiles x 3840-3903
(60 x 64) and z 3200-3263 (50 x 64). Inside a square, tiles are
`<level> <x> <z>` with x and z 0-63.

- Base content uses mostly squares x 29-55 and z 44-76 above ground.
  Dungeons are at z + 100 (z 144-161). Squares east of x 55 are unused.
  Run `bun run mod map grid` to see which squares are in use.
- Square x and z must be 0-255.
- Do not use squares x 47-50, z 47-49, or 48_148: the client handles the
  tutorial island there in a special way.
- In game, `::tele 0,60,50,32,32` takes you to tile (32,32) of `m60_50` on
  level 0.

### Files

```
MyMod/
  maps/
    m60_50.jm2          a whole square: new, or it replaces base m60_50
    m50_50.patch.jm2    a patch for an existing square
    free2play.csv       free-to-play zones to add or remove
    multiway.csv        multi-combat zones to add or remove
```

You can put `.jm2` files in subfolders of `maps/`. The two `.csv` files
must be directly in `maps/`. Other names in `maps/` stop the build.

### Start a square

```sh
bun run mod map new MyMod m60_50 --water 3 --free   # flat grassland island, free-to-play
bun run mod map copy MyMod m50_50                   # copy base m50_50 into the mod to replace it
bun run mod map patch MyMod m50_50                  # an empty patch with instructions
bun run mod map grid                                # which squares are in use
```

Options for `map new`: `--underlay <floor>` (default `grassland`),
`--overlay <floor>` (paint all land tiles), `--height flat|perlin|<1-255>`
(default `flat`; `perlin` gives rolling hills), `--water <n>` (a border of n
blocked water tiles), `--free` (adds the square to `maps/free2play.csv`),
`--force` (overwrite).

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

Every line is `<level> <x> <z>: ...`. Sections can come in any order and
can be empty or left out.

**MAP** tiles. A tile that is not listed has no floor and gets perlin-noise
height. Tokens:

| Token | Meaning |
| --- | --- |
| `h<n>` | Height, 1-255. `h1` is flat at ground level. No `h`: perlin noise (natural hills that fit the squares around it). |
| `u<floor>` | Underlay: the ground colour, blended with the tiles around it (`ugrassland`, `usand`, `umud1`). |
| `o<floor>[;shape[;rotation]]` | Overlay: a floor on top (`owater`, `oroad`, `owoodenfloor`). Shape 0-11 (0 is the full tile, the others cover part of it), rotation 0-3. |
| `f<n>` | Flags, added together: 1 blocks the tile (use it for water), 2 links the tile to the level below (bridges), 4 removes roofs, 8 makes it visible from below, 16 hides it in low detail. |

Base floors are in `content/scripts/floors/underlay.flo` and `overlay.flo`.

**LOC**: `<loc> [shape] [angle]`. Shape (default 10): 0-3 walls, 4-8 wall
decoration, 9 diagonal wall, 10 normal object, 11 diagonal object, 12-21
roofs, 22 ground decoration. Angle (default 0): 0 west, 1 north, 2 east,
3 south. Locs in a map square are part of the client's map: they render
with the map, and the server adds their collision.

**NPC**: `<npc>`. The npc spawns there and respawns after death.

**OBJ**: `<obj> [count]`. Count 1-255 (default 1). The obj comes back
after someone takes it (the obj's `respawnrate`).

### Names and ids

Write locs, npcs, objs and floors **by name** (`oaktree`, `man`, `coins`,
`ugrassland`). Base content files use numbers, and you can use numbers for
base content too (a copied base square keeps them).

- Never use a number for something a mod defines. Mod ids come from the
  `idmap.json` of each install, so they differ between installs. The build
  warns when a number belongs to mod content.
- Numeric floors are the floor id + 1: `u48` is floor id 47, `grassland`.
- Limits of the map format: an underlay floor id must be 173 or less, an
  overlay floor id 254 or less. Base content has 89 floors, so floors that
  mods add get ids from 89.
- A new square gets ids for its two map files (land and locs) in
  `idmap.json` under `map`. Keep `idmap.json`, as for all other ids.

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
- A line that starts with `-` removes entries on that tile with that id
  (`*` means any id). For locs you can also give the shape and angle, for
  objs the count, to remove only exact matches.
- Removals run before additions, so you can remove and add on the same tile.
- A removal that matches nothing stops the build, for example
  `[mod MyMod] maps/m50_50.patch.jm2:3: '-0 10 10: man' matches no npc in the square`.
  The square was probably changed by base content or another mod.

### Which mod wins

- Mods load in load order (see "Enable, disable, load order").
- A whole square (`m60_50.jm2`) replaces the square as it is at that point:
  base content or an earlier mod's square. The build warns when two mods
  have the same whole square; the later mod wins. Patches of earlier mods
  for that square are dropped, with a warning.
- Patches apply in load order on top of the square as it is at that point.
  A patch for a square that another mod adds must load after that mod: add
  it to `dependencies`. A patch for a square that does not exist stops the
  build.
- One mod cannot have the same square twice (two whole files, or two
  patches). A whole file and a patch for the same square in one mod is
  allowed: the patch applies after the whole file.

### Free-to-play and multi-combat zones

A zone is 8 x 8 tiles. `maps/free2play.csv` and `maps/multiway.csv` list
zones to add to (or remove from) the base lists:

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
  there. The client also uses the list to choose which squares a
  free-to-play player downloads in advance.
- Only level 0 counts for free-to-play. Multi-combat zones are per level.
- The build writes the merged lists to `data/pack/server/free2play.csv` and
  `multiway.csv`. With no mod lists, the server reads the base ones.

### Check your square

- The build logs each square mods touch, for example
  `[mods] maps: m60_50 (new square from MyMod): 4096 tiles, 3 locs, 2 npcs, 1 objs`.
  The packed file is in `data/pack/mods/maps/m60_50.jm2` (names resolved
  to ids).
- The server logs what it loaded at start, for example
  `[mods] maps: m60_50 (new square, MyMod): 256 zones with collision, 746 blocked tiles, 5 locs, 4 objs, 3 npcs`.
- `bun run mod:inspect map m60_50 0 30 30` shows a packed square and one
  tile, as the client and the server get them.
- The server loads maps when it starts. After a rebuild, restart the
  server to see map changes.

### Not covered here

- **Music**: the music of an area comes from the base `musicregion`
  dbtable, not from map files: one row per square, keyed by the square's
  south-west tile on level 0. A new square has no music until a mod adds a
  row, for example in `config/music.dbrow`:

  ```
  [musicregion_60_50]
  table=musicregion
  data=mapsquare,0_60_50_0_0
  data=musicdata,music_Harmony
  ```

  This needs `.dbrow` support in mods (see the data types section).
- **New floors**: `.flo` floors come from the data types capability. Use
  them in maps by name.
- **World map**: `bun run tools/pack/map/Worldmap.ts` (after a build)
  includes mod squares and the merged zone lists. The engine does not serve
  `worldmap.jag`, and the client's map viewer only shows squares x 36-55,
  z 44-62. Floors that mods add are black on it.

## Building and testing

- `bun run build` packs everything. When any file of an enabled mod changes,
  or a mod is added, removed, enabled or disabled, the next build repacks
  everything mods can affect. So removed content really disappears.
- The dev server (`bun run quickstart` without `NODE_PRODUCTION`) watches
  `mods/` and rebuilds on change, like it does for content.
- `BUILD_MODS_DIR=<dir>` builds or runs with a different mods folder.
- `BUILD_VERIFY=true` still checks base content. It skips, with an info line,
  the config types that mods change.
- `bun run mod:inspect …` shows what was packed, for example
  `bun run mod:inspect config npc jemery_mclabe` or
  `bun run mod:inspect script jemery`.
