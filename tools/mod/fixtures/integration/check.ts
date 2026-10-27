// Checks for the integration fixture (run by `bun run mod:fixture integration`)
//
// Each capability has its own fixture. This one checks that they work together,
// the way MODDING.md's "Making a new land" and "Making a quest" walkthroughs use them:
//
// int_land:  mod floors (data) used by name in a new map square (maps), an npc
//            placed in the square, a mod song (audio) with a music table row
//            (dbrow) whose play button is a new component in the base music
//            interface (interfaces), and area music through a musicregion row
//            and a [mapzone] script (scripts).
// int_quest: depends on int_land. Constants and a perm varp (data, configs), a
//            quest list entry (interfaces), a patch of int_land's npc (config
//            patches), an override of int_land's npc script and of the base
//            quest procs, calling their originals (script overrides), and an
//            obj spawn in the new square (spawns).

import fs from 'fs';
import path from 'path';

import NpcType from '#/cache/config/NpcType.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { discoverMods } from '#/mod/ModDiscovery.js';
import Environment from '#/util/Environment.js';
import { expect, getConfig, readBasePack, readCache, readCompiledScripts, readIdMap } from '#tools/mod/Inspect.js';
import { children, getComponent } from '#tools/mod/InspectInterfaces.js';
import { readClientSquare, readServerSquare, tileIndex } from '#tools/mod/MapInspect.js';

const fixture = Environment.BUILD_MODS_DIR;
const ids = readIdMap(fixture);
// staged mod scripts: data/pack/mods/scripts/<mod>/<path under scripts/>
const staged = (mod: string, file: string) => path.join('mods', 'scripts', mod, file);

// ---- load order ----
const order = discoverMods(fixture).mods.map(m => m.name);
expect(order.join(',') === 'int_land,int_quest', `load order is int_land, int_quest (got ${order.join(', ')})`);

// ---- mod floors by name in a new map square (data types + maps) ----
const baseFlo = readBasePack('flo');
const moss = ids.flo?.int_moss;
const pathFloor = ids.flo?.int_path;
expect(moss === baseFlo.size && pathFloor === baseFlo.size + 1, `mod floors get flo ids after the ${baseFlo.size} base floors (int_moss ${moss}, int_path ${pathFloor})`);
expect(((await getConfig('flo', 'int_path')) as { overlay?: boolean } | null)?.overlay === true, 'int_path is packed as an overlay floor');

const server = readServerSquare(62, 50);
const client = readClientSquare(62, 50);
expect(server && client, 'm62_50 is packed for the server and the client');
expect(JSON.stringify(server!.tiles) === JSON.stringify(client!.tiles), 'm62_50: client and server tiles are identical');
const tile = (x: number, z: number) => server!.tiles[tileIndex(0, x, z)];
expect(tile(30, 30).underlay === moss! + 1 && tile(30, 30).overlay === 0, 'm62_50: uint_moss (by name) packs as underlay int_moss + 1');
expect(tile(32, 30).overlay === pathFloor! + 1 && tile(32, 30).underlay === moss! + 1, 'm62_50: oint_path (by name) packs as overlay int_path + 1');
expect(tile(24, 30).overlay === baseFlo.get('water')! + 1 && tile(24, 30).flags === 1, 'm62_50: base floor water on the blocked border');
expect(
    server!.npcs.some(n => n.id === ids.npc.int_warden && n.x === 33 && n.z === 33),
    'm62_50: the mod npc int_warden (by name) spawns at (33,33)'
);

// ---- a song in the music tab and area music (audio + dbrow + interfaces + scripts) ----
const midi = ids.midi?.int_theme;
expect(midi !== undefined && readCache(3, midi) !== null, `the song int_theme is packed as midi ${midi}`);

const musicButton = getComponent('music:int_theme');
expect(musicButton !== null && musicButton.id === ids.interface['music:int_theme'], 'music:int_theme is a new component of the base music interface');
const musicLayer = getComponent('music:com_0')!;
const musicEntries = children(musicLayer);
const lastBase = musicEntries.filter(c => c.name !== 'music:int_theme').reduce((a, b) => (b.y + getComponent(b.name)!.height > a.y + getComponent(a.name)!.height ? b : a));
const ours = musicEntries.find(c => c.name === 'music:int_theme');
expect(ours && ours.y === lastBase.y + getComponent(lastBase.name)!.height + 2, `music:int_theme is placed 2 px below the lowest base entry ${lastBase.name} (y=${ours?.y})`);
expect(musicLayer.scroll >= ours!.y + musicButton!.height, `the music list scroll height grew to fit it (${musicLayer.scroll})`);

const musicRow = (await getConfig('dbrow', 'music_int_theme')) as { columnValues: unknown[][] } | null;
expect(musicRow && musicRow.columnValues[0][0] === 'Int Theme' && musicRow.columnValues[1][0] === musicButton!.id, 'the music row names the song and points at the mod play button');
const regionRow = (await getConfig('dbrow', 'musicregion_int_62_50')) as { columnValues: unknown[][] } | null;
const squareCoord = ((62 * 64) << 14) | (50 * 64); // 0_62_50_0_0
expect(regionRow && regionRow.columnValues[0][0] === squareCoord && regionRow.columnValues[1][0] === ids.dbrow.music_int_theme, 'the musicregion row maps m62_50 to the mod music row');

const scripts = readCompiledScripts();
for (const name of ['[mapzone,0_62_50]', '[if_button,music:int_theme]', '[oploc1,int_ferry]']) {
    expect(scripts.get(name)?.source.includes(staged('int_land', 'land.rs2')), `${name} is compiled from int_land`);
}

// ---- the quest (data + configs + interfaces + config patches + script overrides + spawns) ----
const constants = new Map(
    fs
        .readFileSync('data/symbols/constant.sym', 'utf-8')
        .split('\n')
        .map(l => l.split('\t') as [string, string])
);
expect(constants.get('int_quest_complete') === '2' && constants.get('int_quest_questpoints') === '1', 'mod constants are compiler symbols');
expect(((await getConfig('varp', 'int_quest')) as { scope?: number } | null)?.scope === 1, 'the quest varp is perm (saved with the player)');

const questEntry = getComponent('questlist:int_quest');
expect(questEntry !== null && children(getComponent('questlist:com_0')!).some(c => c.name === 'questlist:int_quest'), 'questlist:int_quest is a new entry in the quest list layer com_0');

ScriptProvider.load('data/pack');
NpcType.load('data/pack');
const warden = NpcType.getByName('int_warden')!;
expect(warden.op?.[0] === 'Talk-to' && warden.op?.[2] === 'Ask-about-quest', "int_quest's patch adds op3 to int_land's npc and keeps op1");

const script = (name: string) => ScriptProvider.getByName(name);
expect(ScriptProvider.getByTrigger(ServerTriggerType.OPNPC1, warden.id, warden.category)?.name === '[opnpc1,int_warden]', 'talking to the warden runs a script');
expect(script('[opnpc1,int_warden]')?.info.sourceFilePath.includes(staged('int_quest', 'quest.rs2')), "[opnpc1,int_warden] is int_quest's override");
expect(script('[label,original_opnpc1_int_warden]')?.info.sourceFilePath.includes(staged('int_land', 'land.rs2')), "@original_opnpc1_int_warden is int_land's script");
expect(script('[proc,update_questlist]')?.info.sourceFilePath.includes(staged('int_quest', 'quest.rs2')), '[proc,update_questlist] is the quest mod override');
expect(script('[proc,original_proc_update_questlist]') !== undefined && script('[proc,original_proc_count_questpoints]') !== undefined, 'the base quest procs stay callable as originals');
expect(script('[queue,int_quest_complete]') !== undefined && script('[debugproc,int_quest_stage]') !== undefined, '[queue,int_quest_complete] and the testing debugproc are compiled');

// spawns.json names are checked at build time, so a successful build means int_token resolved
expect(ids.obj.int_token !== undefined && (await getConfig('obj', 'int_token')) !== null, 'the quest item int_token is packed (and spawned by spawns.json)');

console.log('integration fixture: all checks passed');
