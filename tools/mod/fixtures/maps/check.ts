// Checks for the maps fixture (run by `bun run mod:fixture maps` after the build)
//
// maps_base: a new square m60_50 (made with `bun run mod map new`), a patch of
//            the base square m50_50, zone lists, spawns.json objs
// maps_addon (loads after maps_base): patches m60_50, replaces the base square
//            m29_75, wins the m61_50 conflict, removes one free-to-play zone
//
// 1. this file: packed bytes decoded with tools/mod/MapInspect.ts
// 2. server-check.ts: the server's own GameMap.init() and worldBoot hooks
// 3. client-check.ts: the web client's own OnDemand/World/CollisionMap code

import child_process from 'child_process';
import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { expect, readBasePack, readIdMap } from '#tools/mod/Inspect.js';
import { expectedFromJm2, readClientSquare, readMapIndex, readServerSquare, sortSquare, tileIndex } from '#tools/mod/MapInspect.js';
import type { PackedSquare } from '#tools/mod/MapInspect.js';
import { applyJm2Patch, parseJm2 } from '#tools/pack/map/Jm2.js';
import type { Jm2Resolver } from '#tools/pack/map/Jm2.js';

const fixture = Environment.BUILD_MODS_DIR;
const ids = readIdMap(fixture);
const basePacks = { map: readBasePack('map'), loc: readBasePack('loc'), npc: readBasePack('npc'), obj: readBasePack('obj'), flo: readBasePack('flo') };
const floor = (name: string) => basePacks.flo.get(name)! + 1;
const locId = (name: string) => basePacks.loc.get(name) ?? ids.loc[name];

// ---- ids and the client map index ----
const baseMax = Math.max(...basePacks.map.values()) + 1;
expect(ids.map.m60_50 === baseMax && ids.map.l60_50 === baseMax + 1 && ids.map.m61_50 === baseMax + 2 && ids.map.l61_50 === baseMax + 3, `new squares get map ids right after base content (${baseMax}..${baseMax + 3})`);
expect(ids.map.m29_75 === undefined && ids.map.m50_50 === undefined, 'replaced and patched base squares keep their base ids');

const index = readMapIndex();
const entry = (x: number, z: number) => index.find(e => e.x === x && e.z === z);
expect(index.length === basePacks.map.size / 2 + 2, `map_index has the ${basePacks.map.size / 2} base squares plus 2 new ones`);
expect(entry(60, 50)?.land === ids.map.m60_50 && entry(60, 50)?.loc === ids.map.l60_50 && entry(60, 50)?.free === true, 'map_index: m60_50 at its ids, free-to-play');
expect(entry(61, 50)?.free === false, 'map_index: m61_50 is members (not prefetched)');
expect(entry(29, 75)?.land === basePacks.map.get('m29_75'), 'map_index: m29_75 keeps its base id');

// ---- the new square m60_50: client and server data agree ----
const server60 = readServerSquare(60, 50)!;
const client60 = readClientSquare(60, 50)!;
expect(server60 && client60, 'm60_50 is packed for the server and the client');
expect(JSON.stringify(server60.tiles) === JSON.stringify(client60.tiles) && JSON.stringify(server60.locs) === JSON.stringify(client60.locs), 'm60_50: client and server land/loc data are identical');
const tile60 = (x: number, z: number) => server60.tiles[tileIndex(0, x, z)];
expect(tile60(0, 0).overlay === floor('water') && tile60(0, 0).flags === 1 && tile60(2, 40).overlay === floor('water'), 'm60_50: 3-tile water border, blocked');
expect(tile60(3, 40).overlay === 0 && tile60(31, 31).underlay === floor('grassland') && tile60(31, 31).height === 1, 'm60_50: flat grassland inside the border');
expect(
    server60.tiles.slice(tileIndex(1, 0, 0)).every(t => t.height === null && !t.overlay && !t.underlay && !t.flags),
    'm60_50: levels 1-3 are empty'
);
const locSet = (sq: { locs: PackedSquare['locs'] }) => sq.locs.map(l => `${l.id}@${l.level},${l.x},${l.z}/${l.shape},${l.angle}`).sort();
expect(
    JSON.stringify(locSet(server60)) === JSON.stringify([`${ids.loc.maps_shrine}@0,30,30/10,0`, `${locId('tree')}@0,20,20/10,0`, `${locId('tree2')}@0,25,25/10,2`, `${locId('tree2')}@0,40,40/10,1`].sort()),
    "m60_50: locs are the shrine, tree, tree2 (by id) and maps_addon's tree2"
);
expect(
    JSON.stringify(server60.npcs) ===
        JSON.stringify([
            { id: ids.npc.maps_hermit, level: 0, x: 32, z: 32, count: 1 },
            { id: basePacks.npc.get('man'), level: 0, x: 34, z: 34, count: 1 }
        ]),
    'm60_50: npcs maps_hermit and man'
);
expect(JSON.stringify(server60.objs) === JSON.stringify([{ id: basePacks.obj.get('coins'), level: 0, x: 33, z: 32, count: 25 }]), 'm60_50: 25 coins; maps_addon removed maps_relic');

// ---- the patched base square m50_50: base content plus exactly the patch ----
// The expected square is built by hand from the base .jm2 (not with the
// loader's patch code) and compared with the decoded packed square.
const base50 = parseJm2(fs.readFileSync(path.join(Environment.BUILD_SRC_DIR, 'maps', 'm50_50.jm2'), 'utf-8'), { error: (line, message) => new Error(`m50_50.jm2:${line}: ${message}`) });
const baseLocCount = base50.locs.length;
const at = (x: number, z: number) => (e: { level: number; x: number; z: number }) => e.level === 0 && e.x === x && e.z === z;
base50.land.set(tileIndex(0, 20, 20), { height: 1, overlay: floor('marble'), underlay: floor('grassland') });
base50.locs = base50.locs.filter(l => !(at(17, 41)(l) && l.id === locId('tree')));
base50.locs.push({ id: ids.loc.maps_shrine, level: 0, x: 17, z: 41, shape: 10, angle: 2, line: 0 });
base50.npcs = base50.npcs.filter(n => !(at(0, 38)(n) && n.id === basePacks.npc.get('giantspider1')));
base50.npcs.push({ id: ids.npc.maps_hermit, level: 0, x: 1, z: 38, line: 0 });
base50.objs = base50.objs.filter(o => !(at(5, 27)(o) && o.id === basePacks.obj.get('bronze_arrow')));
base50.objs.push({ id: basePacks.obj.get('coins')!, level: 0, x: 5, z: 28, count: 50, line: 0 });
expect(base50.locs.length === baseLocCount, 'm50_50 base content has the tree at (17,41) the patch removes');

const server50 = sortSquare(readServerSquare(50, 50)!);
const expected50 = expectedFromJm2(base50);
expect(JSON.stringify(server50.tiles) === JSON.stringify(expected50.tiles), 'm50_50: base terrain, except tile (20,20) which is now marble on grassland');
expect(JSON.stringify(server50.locs) === JSON.stringify(expected50.locs), `m50_50: the ${baseLocCount} base locs, with the shrine instead of the tree at (17,41)`);
expect(JSON.stringify(server50.npcs) === JSON.stringify(expected50.npcs), 'm50_50: base npcs, with maps_hermit instead of giantspider1 at (0,38)');
expect(JSON.stringify(server50.objs) === JSON.stringify(expected50.objs), 'm50_50: base objs, with 50 coins instead of the bronze arrow at (5,27)');
const client50 = readClientSquare(50, 50)!;
expect(JSON.stringify(client50.tiles) === JSON.stringify(expected50.tiles) && JSON.stringify(sortSquare({ ...client50, npcs: [], objs: [] }).locs) === JSON.stringify(expected50.locs), 'm50_50: the client gets the same land and locs');

// ---- the replaced base square m29_75 and the conflict m61_50 ----
const server29 = readServerSquare(29, 75)!;
const sand = server29.tiles.filter(t => t.underlay === floor('sand')).length;
const nonEmpty = server29.tiles.filter(t => t.height !== null || t.overlay || t.underlay || t.flags).length;
expect(sand === 64 && nonEmpty === 64, 'm29_75: replaced as a whole: 64 sand tiles, nothing else');
expect(JSON.stringify(locSet(server29)) === JSON.stringify([`${ids.loc.maps_shrine}@0,4,4/10,3`]) && server29.npcs.length === 0 && server29.objs.length === 0, "m29_75: only the replacement's shrine; base locs, npcs and objs are gone");
const server61 = readServerSquare(61, 50)!;
expect(server61.tiles[tileIndex(0, 0, 0)].underlay === floor('sand') && server61.locs.length === 1, 'm61_50: maps_addon (later in load order) wins the conflict');

// ---- staged files, zone lists, recorded outputs ----
for (const name of ['m50_50', 'm60_50', 'm61_50', 'm29_75']) {
    expect(fs.existsSync(`data/pack/mods/maps/${name}.jm2`), `staged data/pack/mods/maps/${name}.jm2`);
}
const zoneLines = (file: string) =>
    fs
        .readFileSync(file, 'ascii')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('//'));
const baseFree = zoneLines(path.join(Environment.BUILD_SRC_DIR, 'maps', 'free2play.csv'));
const free = zoneLines('data/pack/server/free2play.csv');
const free60 = free.filter(l => l.startsWith('0_60_50_'));
expect(free60.length === 63 && !free60.includes('0_60_50_56_56'), 'free2play.csv: m60_50 has 63 free zones (64 from maps_base, minus the one maps_addon removed)');
expect(free.length === baseFree.length + 63 && baseFree.every(l => free.includes(l)), 'free2play.csv: every base zone is kept');
const multi = zoneLines('data/pack/server/multiway.csv');
expect(multi.includes('0_60_50_24_24') && multi.length === zoneLines(path.join(Environment.BUILD_SRC_DIR, 'maps', 'multiway.csv')).length + 1, 'multiway.csv: base zones plus 0_60_50_24_24');

const state = JSON.parse(fs.readFileSync('data/pack/mods/state.json', 'utf-8')) as { outputs: string[] };
for (const output of ['data/pack/server/maps/m60_50', 'data/pack/server/maps/o60_50', 'data/pack/client/maps/l61_50', 'data/pack/server/free2play.csv', 'data/pack/server/multiway.csv']) {
    expect(state.outputs.includes(output), `recorded output ${output} (deleted when the mod set changes)`);
}
expect(!state.outputs.includes('data/pack/server/maps/m50_50') && !state.outputs.includes('data/pack/server/maps/m29_75'), 'base square outputs are not recorded (base packing rewrites them)');

const contentPack = fs.readFileSync(path.join(Environment.BUILD_SRC_DIR, 'pack', 'map.pack'), 'utf-8');
expect(!/=m6[01]_50$/m.test(contentPack) && !/=l6[01]_50$/m.test(contentPack), 'content/pack/map.pack has no mod squares');

// ---- parser errors (no build needed) ----
const resolver: Jm2Resolver = {
    floor: name => (basePacks.flo.has(name) ? basePacks.flo.get(name)! : -1),
    loc: name => locId(name) ?? -1,
    npc: name => basePacks.npc.get(name) ?? -1,
    obj: name => basePacks.obj.get(name) ?? -1
};
function parseError(text: string, patch = false): string {
    try {
        parseJm2(text, { patch, resolve: resolver, error: (line, message) => new Error(`${line}: ${message}`) });
    } catch (err) {
        return (err as Error).message;
    }
    return '(no error)';
}
const errorCases: [string, string, boolean?][] = [
    ['0 0 0: ugrassland', '1: Expected a section header such as "==== MAP ====" before the first line'],
    ['==== MAPS ====', "1: Unknown section 'MAPS' (expected one of MAP, LOC, NPC, OBJ)"],
    ['==== MAP ====\n0 64 0: ugrassland', '2: Tile 0 64 0 is outside the square (level 0-3, x and z 0-63)'],
    ['==== MAP ====\n0 1 1: ugrassland\n0 1 1: usand', '3: Tile 0 1 1 is already defined on line 2'],
    ['==== MAP ====\n0 1 1: unosuchfloor', "2: Unknown floor 'nosuchfloor'"],
    ['==== MAP ====\n0 1 1: u175', '2: Floor 175 (id 174) cannot be used as an underlay: the map format allows underlay floor ids up to 173'],
    ['==== MAP ====\n0 1 1: f0', '2: Flags 0 is out of range (1-32)'],
    ['==== MAP ====\n0 1 1: owater;12', '2: Overlay shape 12 is out of range (0-11)'],
    ['==== MAP ====\n0 1 1: x5', "2: Unknown terrain token 'x5' (expected h<height>, u<floor>, o<floor>[;shape[;rotation]] or f<flags>)"],
    ['==== LOC ====\n0 1 1: nosuchloc', "2: Unknown loc 'nosuchloc'"],
    ['==== LOC ====\n0 1 1: tree 23', '2: Loc shape 23 is out of range (0-22)'],
    ['==== LOC ====\n-0 1 1: tree', "2: Removal lines ('-...') are only allowed in patch files (<square>.patch.jm2)"],
    ['==== OBJ ====\n0 1 1: coins 256', '2: Obj count 256 is out of range (1-255)'],
    ['==== NPC ====\n0 1 1 man', '2: Expected "<level> <x> <z>: ..." but got \'0 1 1 man\''],
    ['==== MAP ====\n-0 1 1: ugrassland', "2: MAP lines cannot be removed; write the tile with no tokens ('0 5 5:') to reset it", true]
];
for (const [text, expected, patch] of errorCases) {
    const got = parseError(text, patch);
    expect(got === expected, `parser error: ${expected}${got === expected ? '' : ` (got: ${got})`}`);
}
const square = parseJm2('==== LOC ====\n0 1 1: tree', { resolve: resolver, error: (l, m) => new Error(`${l}: ${m}`) });
const patch = parseJm2('==== LOC ====\n-0 1 2: tree', { patch: true, resolve: resolver, error: (l, m) => new Error(`${l}: ${m}`) });
let patchError = '(no error)';
try {
    applyJm2Patch(square, patch, (l, m) => new Error(`${l}: ${m}`));
} catch (err) {
    patchError = (err as Error).message;
}
expect(patchError === "2: '-0 1 2: tree' matches no loc in the square", `patch error: a removal that matches nothing fails (${patchError})`);
expect(parseError('==== MAP ====\n0 1 1: h1 // a comment\n// whole-line comment\n==== LOC ====\n0 1 1: tree 10 // another') === '(no error)', 'mod files may have // comments');

// ---- the server's and the client's own loaders ----
function runCheck(script: string, args: string[] = []): boolean {
    const result = child_process.spawnSync('bun', [path.join(path.dirname(new URL(import.meta.url).pathname), script), ...args], { env: process.env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    for (const line of output.split('\n')) {
        if (!line.includes('missing model') && (line.startsWith('ok') || line.startsWith('not ok') || line.includes('[mods]') || line.includes('checks') || line.includes('rror'))) {
            console.log(`  ${line}`);
        }
    }
    return result.status === 0;
}

expect(runCheck('server-check.ts'), 'server: GameMap.init() and worldBoot load the fixture as expected (server-check.ts)');

const clientCandidates = [process.env.CLIENT_DIR, '../client', '../Brumescape_Client-TS'].filter((d): d is string => !!d).map(d => path.resolve(d));
const clientDir = clientCandidates.find(d => fs.existsSync(path.join(d, 'src', 'dash3d', 'World.ts')));
if (!clientDir) {
    console.log(`SKIP client-check.ts: no client checkout found (set CLIENT_DIR; looked in ${clientCandidates.join(', ')})`);
} else if (!fs.existsSync(path.join(clientDir, 'node_modules', 'fflate'))) {
    console.log(`SKIP client-check.ts: ${clientDir} has no node_modules (run bun install there)`);
} else {
    expect(runCheck('client-check.ts', [clientDir]), `client: the web client's decoders read the fixture as expected (client-check.ts, ${clientDir})`);
}
