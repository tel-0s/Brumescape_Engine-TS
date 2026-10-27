# mods/

This folder holds the mods that the build packs. Each mod is a folder with a
`mod.json`. **The guide for mod authors is [`MODDING.md`](../MODDING.md)** in
the engine's root folder.

```sh
bun run mod create MyMod     # scaffold mods/MyMod/ with every folder and starter files
bun run mod validate MyMod   # build base content plus only this mod
bun run mod list             # mods in load order
bun run build                # build base content plus every enabled mod
```

Files in this folder that are not mods:

| File | What it is |
| --- | --- |
| `idmap.json` | The stable ids of every name that mods added. The build writes it. **Commit it and never delete it**: player saves store these ids. See [Stable ids and player saves](../MODDING.md#stable-ids-and-player-saves). |
| `mods.json` | Optional: `{ "disabled": ["MyMod"] }` turns mods off. `bun run mod enable` and `disable` edit it. |
| `README.md` | This file. |

The two example mods:

- `MclabeCinematicUniverse`: a new npc, obj, loc, enum and varp, a custom
  model and texture, scripts and `spawns.json`.
- `brumescape`: replaces the title screen logo.

More examples, one per capability, are the test fixtures in
`tools/mod/fixtures/`. `tools/mod/fixtures/integration/` is a small new land
and a quest that use most capabilities together.
