// Checks for the saves fixture: player saves survive a mod being disabled or
// removed. The build has both mods. The check then hides saves_a_mod's
// configs in this process, the way a build without it looks to the server:
//   - as gaps (its ids stay below saves_b_after's, packed without a name)
//   - past the end (both mods gone, so the config counts shrink)
// A save made with the mods must load without the mod (no rejected login,
// no appearance crash), keep the mod's varps, inventories and objs out of the
// game, write them back, and give them back when the mod returns.
import '#/engine/World.js';

import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import { expect, PACK_DIR, readIdMap } from '#tools/mod/Inspect.js';

ParamType.load(PACK_DIR);
ObjType.load(PACK_DIR);
InvType.load(PACK_DIR);
VarPlayerType.load(PACK_DIR);

const ids = readIdMap(Environment.BUILD_MODS_DIR);
const varp = ids.varp.saves_progress;
const afterVarp = ids.varp.saves_after_progress;
const hat = ids.obj.saves_hat;
const coin = ids.obj.saves_coin;
const box = ids.inv.saves_box;
const coins = ObjType.getId('coins');
const dagger = ObjType.getId('bronze_dagger');
const HAT_SLOT = ObjType.get(hat).wearpos;

// The config tables, to hide mod ids the way a build without the mod does
type Configs = { configs: { debugname: string | null }[] };
const tables = [VarPlayerType, ObjType, InvType] as unknown as Configs[];
const original = tables.map(t => [...t.configs]);
const names = tables.map(t => t.configs.map(c => c.debugname));

function hideAsGaps(hidden: number[][]) {
    tables.forEach((t, i) => hidden[i].forEach(id => (t.configs[id].debugname = null)));
}
function truncate(lengths: number[]) {
    tables.forEach((t, i) => (t.configs = original[i].slice(0, lengths[i])));
}
function restore() {
    tables.forEach((t, i) => {
        t.configs = [...original[i]];
        t.configs.forEach((c, id) => (c.debugname = names[i][id]));
    });
}

const load = (data: Uint8Array) => PlayerLoading.load('saves_tester', new Packet(data), null);
const at = (p: Player, inv: number, slot: number) => p.getInventory(inv)?.get(slot) ?? null;

function expectHeld(p: Player, what: string) {
    p.appearance = InvType.WORN;
    expect(p.heldVars.get(varp) === 7, `${what}: the mod varp is held`);
    expect(at(p, InvType.INV, 0)?.id === coins && at(p, InvType.INV, 3) === null, `${what}: base coins stay; the mod hat's slot looks empty`);
    expect(p.heldObjs.get(InvType.INV)?.some(o => o.id === hat && o.slot === 3), `${what}: the backpack hat is held at slot 3`);
    expect(at(p, InvType.WORN, HAT_SLOT) === null && p.heldObjs.get(InvType.WORN)?.some(o => o.id === hat), `${what}: the worn hat is held`);
    expect(p.heldInvs.get(box)?.objs.length === 2, `${what}: the mod inventory is held whole`);
    p.generateAppearance();
}

function expectBack(p: Player, what: string) {
    expect(p.vars[varp] === 7 && p.vars[afterVarp] === 3, `${what}: both varps are back`);
    expect(p.heldVars.size === 0 && p.heldInvs.size === 0 && [...p.heldObjs.values()].every(h => h.length === 0), `${what}: nothing is held`);
    expect(at(p, InvType.WORN, HAT_SLOT)?.id === hat, `${what}: the worn hat is back`);
    expect(at(p, box, 1)?.id === coin && at(p, box, 1)?.count === 500 && at(p, box, 2)?.id === coins, `${what}: the mod inventory is back`);
}

try {
    // a save made with both mods
    const made = new Player('saves_tester', 1n, 1n);
    made.vars[varp] = 7;
    made.vars[afterVarp] = 3;
    made.getInventory(InvType.INV)!.set(0, { id: coins, count: 50 });
    made.getInventory(InvType.INV)!.set(3, { id: hat, count: 1 });
    made.getInventory(InvType.WORN)!.set(HAT_SLOT, { id: hat, count: 1 });
    made.getInventory(box)!.set(1, { id: coin, count: 500 });
    made.getInventory(box)!.set(2, { id: coins, count: 100 });
    const save1 = made.save();

    // saves_a_mod disabled: its ids are gaps. The game reuses slot 3.
    hideAsGaps([[varp], [hat, coin], [box]]);
    const gap = load(save1);
    expect(gap.vars[afterVarp] === 3, 'gaps: the varp of the enabled mod still loads');
    expectHeld(gap, 'gaps');
    gap.getInventory(InvType.INV)!.set(3, { id: dagger, count: 1 });
    const save2 = gap.save();
    restore();

    const back = load(save2);
    expectBack(back, 'gaps, then enabled');
    expect(at(back, InvType.INV, 3)?.id === dagger && at(back, InvType.INV, 1)?.id === hat, 'gaps, then enabled: slot 3 keeps the dagger; the hat comes back in the first free slot');

    // both mods removed: the config counts end before their ids
    truncate([Math.min(varp, afterVarp), Math.min(hat, coin, ids.obj.saves_after_item), Math.min(box, ids.inv.saves_after_box)]);
    const gone = load(save1);
    expect(gone.heldVars.get(afterVarp) === 3, 'past the end: the other mod varp is held too');
    expectHeld(gone, 'past the end');
    const save3 = gone.save();
    restore();

    const back2 = load(save3);
    expectBack(back2, 'past the end, then enabled');
    expect(at(back2, InvType.INV, 3)?.id === hat, 'past the end, then enabled: the backpack hat is back in slot 3');
} catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
}
// World keeps timers alive
process.exit(0);
