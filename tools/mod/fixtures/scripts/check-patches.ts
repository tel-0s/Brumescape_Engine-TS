// Config patch checks for the scripts fixture (imported by check.ts). Reads
// the packed configs back with the engine's decoders: the server files in
// data/pack/server plus the client config jag, and separately the client's
// npc.dat straight from the client cache (archive 0, file 2).
import CategoryType from '#/cache/config/CategoryType.js';
import EnumType from '#/cache/config/EnumType.js';
import InvType from '#/cache/config/InvType.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import StructType from '#/cache/config/StructType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { expect, readCache } from '#tools/mod/Inspect.js';

ParamType.load('data/pack');
for (const type of [CategoryType, EnumType, InvType, LocType, NpcType, ObjType, StructType, VarPlayerType]) {
    type.load('data/pack');
}

const param = (name: string) => {
    const p = ParamType.getByName(name);
    expect(p, `param ${name} exists`);
    return p.id;
};

// ---- npc man: two patches (patch_demo, then patch_chain) ----
const man = NpcType.getByName('man')!;
expect(man.name === 'Robert', `man's name comes from the later patch (patch_chain) (got ${man.name})`);
expect(man.op?.[0] === 'Talk-to', 'man op1 is unchanged (Talk-to)');
expect(man.op?.[1] === null || man.op?.[1] === undefined, `man op2 (Attack) is removed (got ${man.op?.[1]})`);
expect(man.op?.[2] === 'Steal-from', `man op3 is replaced (got ${man.op?.[2]})`);
expect(man.params?.get(param('stabdefence')) === 5, 'man param stabdefence is replaced by its sub-key');
expect(!man.params?.has(param('slashdefence')), 'man param slashdefence is removed');
expect(man.params?.get(param('crushdefence')) === -21, 'man param crushdefence is unchanged');
expect(man.params?.get(param('patch_demo_flag')) === 1, 'man gets the mod param patch_demo_flag');
expect(man.vislevel === 5, 'man vislevel is replaced');
expect(man.category === CategoryType.getByName('citizen')!.id, 'man keeps category=citizen');
expect(man.respawnrate === 50 && man.models?.length === 7, 'man keeps the properties no patch touches');

// the same, decoded from the client cache only (what the web client loads)
const configJag = new Jagfile(new Packet(readCache(0, 2)!));
const clientNpcs = configJag.read('npc.dat')!;
const count = clientNpcs.g2();
clientNpcs.pos = 2;
let clientMan: NpcType | null = null;
for (let id = 0; id < count; id++) {
    const type = new NpcType(id);
    type.decodeType(clientNpcs);
    if (id === man.id) {
        clientMan = type;
        break;
    }
}
expect(clientMan?.name === 'Robert' && clientMan.op?.[2] === 'Steal-from' && !clientMan.op?.[1], 'the client cache has the patched man (name, op2 removed, op3)');

// ---- npc hans: patched by patch_demo, then replaced entirely by patch_chain ----
const hans = NpcType.getByName('hans')!;
expect(hans.name === 'Hans (replaced)', `hans is patch_chain's full definition (got ${hans.name})`);
expect(!hans.op?.[2], "patch_demo's op3 for hans no longer applies");

// ---- obj cake ----
const cake = ObjType.getByName('cake')!;
expect(cake.name === 'Birthday cake' && cake.cost === 100, 'cake name and cost are patched');
expect(!cake.iop?.[0] && cake.iop?.[1] === 'Admire', 'cake iop1 is removed and iop2 added');
expect(cake.params.get(param('patch_demo_flag')) === 2, 'cake gets param patch_demo_flag');
expect(cake.params.get(param('next_obj_stage')) === ObjType.getByName('partial_cake')!.id, 'cake keeps its other param');
expect(cake.weight === 300 && cake.category !== -1, 'cake keeps weight and category');

// ---- enum: keyed values, and an autoint enum ----
const questNames = EnumType.getByName('quest_names_enum')!;
expect(questNames.values.get(1) === "Cook's Assistant (patched)", 'enum quest_names_enum val 1 is replaced');
expect(!questNames.values.has(5), 'enum quest_names_enum val 5 is removed');
expect(questNames.values.get(100) === 'The Lost Cat', 'enum quest_names_enum val 100 is added');
expect(questNames.values.get(0) === "Black Knight's Fortress", 'enum quest_names_enum val 0 is unchanged');
const unlocks = EnumType.getByName('levelup_unlocks_attack')!;
const unlockKeys = Array.from(unlocks.values.keys());
expect(unlocks.values.get(0) === 5 && unlocks.values.get(unlockKeys.length - 1) === 99, '+val appends to the autoint enum levelup_unlocks_attack');

// ---- struct, inv, loc, varp ----
const guam = StructType.getByName('unf_guam_potion')!;
expect(guam.params?.get(param('brew_potion_message')) === 'You stir the Guam Leaf into the water.', 'struct param is replaced');
expect(guam.params?.get(param('brew_potion_solvent')) === ObjType.getByName('vial_water')!.id, 'struct keeps its other params');

const shop = InvType.getByName('generalshop1')!;
expect(shop.stockobj?.length === 7, `inv generalshop1 has 7 stock entries after -stock8 (got ${shop.stockobj?.length})`);
expect(shop.stockobj?.[1] === ObjType.getByName('jug_empty')!.id && shop.stockcount?.[1] === 7, 'inv stock2 is replaced');
expect(shop.stockobj?.[0] === ObjType.getByName('pot_empty')!.id, 'inv stock1 is unchanged');

const range = LocType.getByName('cooksquestrange')!;
expect(range.name === "Cook's range" && range.op?.[0] === 'Inspect', 'loc cooksquestrange name and op1 are patched');
expect(range.category === CategoryType.getByName('cooking_oven')!.id && range.length === 2, 'loc keeps its other properties');

const cookquest = VarPlayerType.getByName('cookquest')!;
expect(cookquest.transmit === true && cookquest.scope === VarPlayerType.SCOPE_PERM, 'varp cookquest gets transmit=yes and keeps scope=perm');

console.log('config patches: all checks passed');
