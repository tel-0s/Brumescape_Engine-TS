# TernIsle

A small seabird island in the strait between Rimmington, Port Sarim and
Karamja. It is the first test map for the Brumescape mod loader.

| File | What it does |
| --- | --- |
| `maps/m46_49.patch.jm2` | Patches base square m46_49: the island (254 tiles, smoothed coast, shingle shallows), a pier on the island and one on the mainland shore, trees, rocks, plants, gulls, the hermit, both boatmen and a few obj spawns. |
| `config/ternisle.flo` | `tern_shingle`, the pebbly beach underlay. |
| `config/ternisle.npc` | `tern_boatman` (stands on each pier), `tern_hermit` (Old Halvard) and `tern`. |
| `scripts/ternisle.rs2` | The boatman's ferry dialogue (the side is chosen with `inzone`), Halvard's dialogue, `::~ternisle`, and `[proc,tern_flock]`, which brings five terns to the shingle around Halvard for five minutes (`::~terns`; A Tern for the Worse calls it on completion). |
| `models/tern.obj`, `tern.mtl`, `tern.json` | The tern, made in Blender: 161 vertices, 278 faces, one vertex group per bone. |
| `anims/tern.json` | The tern's bones and 16 frames (bone form): it looks around, preens, stretches its wings and waddles. |
| `config/ternisle.seq` | `tern_ready` and `tern_walk`, the npc's ready and walk animations. |
| `source/build_tern.py` | Makes the tern: `Blender -b --factory-startup -P source/build_tern.py -- models [preview_dir]` from this folder. The build does not read `source/`. |

Visit: talk to the boatman on the small pier on the shore south of
Rimmington (tile 0_46_49_47_31), or type `::~ternisle` in game. The full guide is
`MODDING.md` in the engine's root folder.

```sh
bun run mod validate TernIsle   # base content plus only this mod
bun run build                   # everything
```
