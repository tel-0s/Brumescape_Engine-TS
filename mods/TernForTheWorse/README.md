# A Tern for the Worse

A short free quest on Tern Isle (needs the `TernIsle` mod). The terns have
not come back to the island this spring, and Old Halvard has found a gull
call on the shingle. Who has been calling the gulls in?

Walkthrough: talk to Old Halvard on Tern Isle -> ask Gerrant (Port Sarim
fishing shop) about the gull call -> ask Redbeard Frank (Port Sarim docks)
-> dig up Frank's rum with a spade on the shingle west of the western
willow on Tern Isle -> give it to Frank -> tell Halvard.
Reward: 1 quest point, 500 Fishing XP, a tern feather.

| File | What it does |
| --- | --- |
| `config/ternquest.varp` | `%tern_quest`, the saved progress (stages 0-6). |
| `config/ternquest.constant` | The stages, the quest points, the stash coord, journal colours. |
| `config/ternquest.obj` | The gull call, Frank's rum and the tern feather (base models). |
| `config/ternquest.loc` | The disturbed shingle that marks the stash. |
| `config/patch/quest_names.enum` | Adds the quest to the `::quest` debug cheat's list. |
| `interfaces/questlist.ifpatch` | The quest list entry. |
| `maps/m46_49.patch.jm2` | Places the stash on TernIsle's patched square. |
| `scripts/ternquest.rs2` | Dialogue and progress. Overrides TernIsle's Halvard, base Gerrant, base Redbeard Frank and the base spade, and calls each original for everything the quest does not handle. Also the journal (the base scroll interface), the completion, and the two quest list procs. |

Testing: `::~tern_quest_stage <0-6>` sets the stage.
