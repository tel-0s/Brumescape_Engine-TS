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
| `spawns.json` | NPCs and locs placed in the world when the server boots. |

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
    "locs": [{ "id": "olive_oil_barrel", "coord": "0_50_50_34_32", "shape": 10, "angle": 0 }]
}
```

`coord` is `level_mapsquareX_mapsquareZ_localX_localZ`. NPCs respawn after
death. Locs are permanent. `shape` defaults to 10 (centrepiece) and `angle`
to 0 (west).

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
