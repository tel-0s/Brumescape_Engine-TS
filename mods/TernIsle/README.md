# TernIsle

A small seabird island in the strait between Rimmington, Port Sarim and
Karamja. It is the first test map for the Brumescape mod loader.

| File | What it does |
| --- | --- |
| `maps/m46_49.patch.jm2` | Patches base square m46_49: the island (254 tiles, smoothed coast, shingle shallows), a pier on the island and one on the mainland shore, trees, rocks, plants, gulls, the hermit, both boatmen and a few obj spawns. |
| `config/ternisle.flo` | `tern_shingle`, the pebbly beach underlay. |
| `config/ternisle.npc` | `tern_boatman` (stands on each pier) and `tern_hermit` (Old Halvard). |
| `scripts/ternisle.rs2` | The boatman's ferry dialogue (the side is chosen with `inzone`), Halvard's dialogue, and `::~ternisle`. |

Visit: talk to the boatman on the small pier on the shore south of
Rimmington (tile 0_46_49_47_31), or type `::~ternisle` in game. The full guide is
`MODDING.md` in the engine's root folder.

```sh
bun run mod validate TernIsle   # base content plus only this mod
bun run build                   # everything
```
