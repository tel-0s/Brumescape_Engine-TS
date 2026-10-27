// Checks for the data-audio fixture (run by `bun run mod:fixture data-audio` after the build).
// Everything is read back from the packed output (data/pack, data/symbols).
import fs from 'fs';
import path from 'path';

import Packet from '#/io/Packet.js';
import { readSoundsDat, validateSynthFile } from '#/mod/SynthFormat.js';
import Environment from '#/util/Environment.js';
import { expect, getConfig, readBasePack, readCacheGunzip, readCompiledScripts, readIdMap, readJagEntry, readSymbols, sameBytes } from '#tools/mod/Inspect.js';

const fixture = Environment.BUILD_MODS_DIR;
const content = Environment.BUILD_SRC_DIR;
const ids = readIdMap(fixture);
const file = (p: string) => new Uint8Array(fs.readFileSync(path.join(fixture, p)));

// ---- constants ----
const constants = new Map(
    fs
        .readFileSync('data/symbols/constant.sym', 'utf-8')
        .split('\n')
        .filter(l => l)
        .map(l => l.split('\t') as [string, string])
);
expect(constants.get('da_stage') === '7', 'constant da_stage is in constant.sym');
expect(constants.get('da_price') === '40', 'constant da_price is the later mod\'s override (40, not 25)');
expect(constants.get('da_label') === "Ranger's pass", 'string constant is written without its quotes');
expect(constants.get('true') === '1', 'base constant ^true still exists (override with the same value)');
expect(constants.get('false') === '0', 'other base constants are untouched');
const ranger = (await getConfig('npc', 'da_ranger')) as { vislevel: number; category: number } | null;
expect(ranger?.vislevel === 33, 'npc da_ranger: vislevel=^da_vis was substituted by the mod constant (33)');

// ---- categories ----
const categories = fs
    .readFileSync('data/pack/server/category.dat')
    .length;
{
    const dat = new Packet(new Uint8Array(fs.readFileSync('data/pack/server/category.dat')));
    const count = dat.g2();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        names.push(dat.g1() === 1 ? dat.gjstr() : '');
        if (names[i] !== '') {
            expect(dat.g1() === 0, 'category entry ends with 0');
        }
    }
    expect(categories > 0 && names[ids.category.da_creatures] === 'da_creatures', 'category.dat has da_creatures at its idmap id');
    expect(names[ids.category.da_trinkets] === 'da_trinkets', 'category.dat has da_trinkets at its idmap id');
    expect(ids.category.da_creatures >= readBasePack('category').size, 'mod categories come after the base categories');
    expect(ranger!.category === ids.category.da_creatures, 'npc da_ranger category= resolves to the mod category');
    const trinket = (await getConfig('obj', 'da_trinket')) as { category: number } | null;
    expect(trinket?.category === ids.category.da_trinkets, 'obj da_trinket category= resolves to the mod category');
}
expect(readSymbols('category').get('da_creatures') === ids.category.da_creatures, 'category.sym has da_creatures');

// ---- dbtable / dbrow ----
const table = (await getConfig('dbtable', 'da_shops')) as { id: number; columnNames: string[] } | null;
expect(table && table.columnNames.join(',') === 'npc,price,song', 'dbtable da_shops has its three columns');
expect(table!.id === ids.dbtable.da_shops, 'dbtable da_shops has its idmap id');
expect(readSymbols('dbtable').has('da_shops'), 'dbtable.sym has da_shops');
expect(readSymbols('dbcolumn') && fs.readFileSync('data/symbols/dbcolumn.sym', 'utf-8').includes('da_shops:price'), 'dbcolumn.sym has da_shops:price');
const rangerRow = (await getConfig('dbrow', 'da_shop_ranger')) as { tableId: number; columnValues: (number | string)[][] } | null;
expect(rangerRow?.tableId === table!.id, 'dbrow da_shop_ranger belongs to da_shops');
expect(rangerRow!.columnValues[0][0] === ids.npc.da_ranger, 'dbrow npc column references the mod npc id');
expect(rangerRow!.columnValues[1][0] === 40, 'dbrow price=^da_price is the overridden constant (40)');
const otherRow = (await getConfig('dbrow', 'da_shop_other')) as { columnValues: (number | string)[][] } | null;
expect(otherRow?.columnValues[1][0] === 99, 'dbrow da_shop_other is the later mod\'s version (99, not ^da_stage)');
const musicTable = (await getConfig('dbtable', 'musicregion')) as { id: number } | null;
const adventure = (await getConfig('dbrow', 'music_Adventure')) as { tableId: number } | null;
expect(adventure !== null, 'base dbrow music_Adventure exists');
const adventureId = readSymbols('dbrow').get('music_Adventure')!;
const landRow = (await getConfig('dbrow', 'da_musicregion_land')) as { tableId: number; columnValues: (number | string)[][] } | null;
expect(landRow?.tableId === musicTable!.id, 'a mod dbrow can add a row to the base table musicregion');
expect(landRow!.columnValues[1][0] === adventureId, 'new musicregion row points at the base music row');
const replaced = (await getConfig('dbrow', 'musicregion_29_75')) as { columnValues: (number | string)[][] } | null;
expect(replaced?.columnValues[1][0] === adventureId, 'base dbrow musicregion_29_75 was replaced by the mod (Adventure instead of Trawler)');
const untouched = (await getConfig('dbrow', 'musicregion_30_75')) as { columnValues: (number | string)[][] } | null;
expect(untouched?.columnValues[1][0] === readSymbols('dbrow').get('music_Trawler_Minor'), 'other base musicregion rows are unchanged');

// ---- floors ----
const flo = async (name: string) => (await getConfig('flo', name)) as { rgb: number; overlay: boolean; occlude: boolean; texture: number } | null;
const under = await flo('da_underlay');
expect(under?.rgb === 0x445566 && !under.overlay, 'flo da_underlay is the later mod\'s colour 0x445566, underlay');
const over = await flo('da_overlay');
expect(over?.rgb === 0x884422 && over.overlay && !over.occlude, 'flo da_overlay is an overlay without occlusion');
const tex = await flo('da_overlay_tex');
expect(tex?.overlay && tex.texture === readBasePack('texture').get('planks'), 'flo da_overlay_tex uses the planks texture id');
expect(ids.flo.da_underlay === 89 && ids.flo.da_overlay === 90 && ids.flo.da_overlay_tex === 91, 'new floors are numbered contiguously after the 89 base floors');
expect((await flo('lightgrass'))?.rgb === 0x00ff00, 'base floor lightgrass was replaced');
expect((await flo('grassland'))?.rgb === 0x35720a, 'other base floors are unchanged');
{
    // the client copy (config jag, flo.dat): count + ids line up
    const dat = new Packet(readJagEntry(2, 'flo.dat')!);
    expect(dat.g2() === 92, 'client flo.dat holds 92 floors (89 base + 3)');
}

// ---- synth ----
const synthSyms = readSymbols('synth');
expect(synthSyms.get('da_ping') === ids.synth.da_ping && ids.synth.da_ping === 579, 'synth da_ping is id 579 (right after the 579 base sounds)');
expect(synthSyms.get('da_stumble') === 580, 'synth da_stumble is id 580');
const sounds = readSoundsDat(readJagEntry(8, 'sounds.dat')!);
expect(sounds.size === 581, `sounds.dat holds 581 waves (got ${sounds.size})`);
expect(sameBytes(sounds.get(579), file('da_over/synth/da_ping.synth')), 'da_ping is the later mod\'s file');
expect(!sameBytes(sounds.get(579), file('da_base/synth/da_ping.synth')), 'da_ping is not the earlier mod\'s file');
expect(sameBytes(sounds.get(580), file('da_base/synth/da_stumble.synth')), 'da_stumble is packed');
const batDeath = readBasePack('synth').get('bat_death')!;
expect(batDeath === synthSyms.get('bat_death'), 'bat_death keeps its base id');
expect(sameBytes(sounds.get(batDeath), file('da_over/synth/bat_death.synth')), 'base synth bat_death was replaced by the mod');
const baseHit = readBasePack('synth').get('sound_100')!;
expect(sameBytes(sounds.get(baseHit), new Uint8Array(fs.readFileSync(path.join(content, 'synth/sound_100.synth')))), 'other base synths are byte-identical');
for (const wave of sounds.values()) {
    validateSynthFile(wave); // every packed wave decodes to exactly its own bytes
}

// ---- songs and jingles ----
const midiIds = readBasePack('midi');
expect(ids.midi.da_theme === 270 && ids.midi.da_fanfare === 271, 'midi da_theme/da_fanfare are ids 270/271 (after the 270 base entries)');
expect(sameBytes(readCacheGunzip(3, 270), file('da_base/songs/da_theme.mid')), 'song da_theme is in cache archive 3');
expect(sameBytes(readCacheGunzip(3, 271), file('da_base/jingles/da_fanfare.mid')), 'jingle da_fanfare is in cache archive 3');
expect(sameBytes(readCacheGunzip(3, midiIds.get('scape_main')!), file('da_over/songs/scape_main.mid')), 'base song scape_main was replaced by the mod');
expect(sameBytes(readCacheGunzip(3, midiIds.get('iban')!), new Uint8Array(fs.readFileSync(path.join(content, 'songs/iban.mid')))), 'other base songs are unchanged');
{
    const index = readJagEntry(5, 'midi_index')!;
    const crcs = new Packet(readJagEntry(5, 'midi_crc')!);
    expect(index.length === 272, `midi_index has 272 entries (got ${index.length})`);
    expect(index[271] === 1 && index[270] === 0, 'versionlist marks the mod jingle (and not the mod song) for prefetch');
    expect(index[midiIds.get('advance cooking')!] === 1, 'base jingles are still marked for prefetch');
    crcs.pos = 270 * 4;
    expect(crcs.g4() !== 0, 'midi_crc has a crc for the new song');
}

// ---- scripts ----
const scripts = readCompiledScripts();
expect(scripts.has('[proc,da_greet]') && scripts.has('[opnpc1,da_ranger]') && scripts.has('[mapzone,0_200_200]'), 'scripts using the constant, dbrow, synth and midi compile');

// ---- nothing leaked into the content dir ----
const leaked = fs
    .readdirSync(path.join(content, 'pack'))
    .filter(f => f.endsWith('.pack'))
    .filter(f =>
        fs
            .readFileSync(path.join(content, 'pack', f), 'utf-8')
            .split('\n')
            .some(line => /=(da_|musicregion_land)/.test(line))
    );
expect(leaked.length === 0, `no fixture names in ${content}/pack (${leaked.join(', ') || 'none'})`);
