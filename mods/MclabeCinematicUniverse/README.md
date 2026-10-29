# The Mclabe Cinematic Universe

Three brothers, a barrel of olive oil, and a doctor who does not believe in
germs. The lore and the plan for later quests are in `ROADMAP.md`.

## The Brothers Mclabe (members' quest)

**Requirement:** Plague City. **Rewards:** 2 quest points, 1,500 Herblore
XP, Danvid's Olive Oil.

1. Talk to **Jemery Mclabe**, wandering in Lumbridge Swamp among the giant
   rats. He gives you his brothers' last letters.
2. **Danvid:** his letter points to Creben's Fine Oils in Brimhaven. In the
   bunkhouse south of the Brimhaven docks, talk to **Mags**, then search the
   big **barrel of olive oil**. Danvid drowned in it; you bottle some of the
   oil for Jemery.
3. **Bellamy:** his letter points to West Ardougne. **Nurse Sarah** tells you
   about Dr. Thrick. In his clinic (a rat-infested house in the north-west of
   the city), ask **Dr. Thrick** what he prescribes. Use Bellamy's letter on
   the prescription: the handwriting matches. Confront him; he writes a note
   for Jemery.
4. Bring Jemery the oil and the note.

## Files

| File | What it does |
| --- | --- |
| `config/mclabe.npc` | Jemery Mclabe (mutters every so often), Mags, Dr. Thrick. |
| `config/mclabe.obj` | Danvid's Olive Oil (Mourn), the two letters, the prescription, the note for Jemery. |
| `config/mclabe.loc` | The barrel of olive oil (custom model) and Dr. Thrick's crate of Creben's oil. |
| `config/mclabe.varp`, `mclabe.constant` | `%mclabe_brothers`, `%mclabe_danvid`, `%mclabe_bellamy` and their stages. |
| `config/mclabe.enum` | `mclabe_quotes`: what Jemery mutters. |
| `config/patch/quest_names.enum` | The quest in the `::quest` debug cheat's list. |
| `interfaces/questlist.ifpatch` | The quest list entry, after Biohazard (alphabetical). |
| `maps/m50_49.patch.jm2` | Jemery in Lumbridge Swamp. |
| `maps/m43_50.patch.jm2` | Brimhaven docks bunkhouse: the barrel and Mags. |
| `maps/m38_51.patch.jm2` | West Ardougne: Dr. Thrick's clinic and the crate. |
| `scripts/jemery.rs2` | Jemery: start, progress, finale, completion, muttering. |
| `scripts/danvid.rs2` | Mags, the barrel, Danvid's Olive Oil. |
| `scripts/bellamy.rs2` | Nurse Sarah (override), Dr. Thrick, the handwriting, the crate. |
| `scripts/quest.rs2` | Letters, journal, quest list procs, `::~mclabe_stage`. |
| `models/mclabe_oil_barrel.obj`, `mclabe_oil_bottle.obj` | Made in Blender by `source/build_models.py`. The barrel's staves use `textures/mclabe_oil_texture.png`. |

Rebuild the models (from this folder):
`Blender -b --factory-startup -P source/build_models.py -- models [preview_dir]`.

Testing: `::~mclabe_stage <quest> <danvid> <bellamy>` sets the three stages
(see `config/mclabe.constant`).
