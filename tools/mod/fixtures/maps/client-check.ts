// Decodes the maps fixture build with the web client's own code
// (Brumescape_Client-TS: io/OnDemand, io/Jagfile, dash3d/World, dash3d/CollisionMap,
// config/LocType, config/FloType). Run by check.ts as:
//   bun tools/mod/fixtures/maps/client-check.ts <client repo dir>
// Reads data/pack/client/versionlist, data/pack/client/config and data/pack/ondemand.zip,
// which is what the web server sends.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import * as fflate from 'fflate';

import Packet from '#/io/Packet.js';
import { expect, readBasePack, readIdMap } from '#tools/mod/Inspect.js';
import Environment from '#/util/Environment.js';

const clientDir = path.resolve(process.argv[2] ?? '');
const src = (file: string) => path.join(clientDir, 'src', file);
if (!fs.existsSync(src('dash3d/World.ts'))) {
    throw new Error(`${clientDir} is not a client checkout (no src/dash3d/World.ts)`);
}

// The client's 3rdparty/deps.js loads browser audio helpers at import time
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.document ??= { addEventListener() {}, removeEventListener() {}, hidden: true };

const { default: Jagfile } = await import(src('io/Jagfile.ts'));
const { default: OnDemand } = await import(src('io/OnDemand.ts'));
const { default: World } = await import(src('dash3d/World.ts'));
const { default: CollisionMap } = await import(src('dash3d/CollisionMap.ts'));
const { CollisionFlag } = await import(src('dash3d/CollisionFlag.ts'));
const { default: LocType } = await import(src('config/LocType.ts'));
const { default: FloType } = await import(src('config/FloType.ts'));
const { default: SeqType } = await import(src('config/SeqType.ts'));
const { Int32Array3d, Uint8Array3d } = await import(src('util/Arrays.ts'));

const ids = readIdMap(Environment.BUILD_MODS_DIR);
const flo = readBasePack('flo');
const floor = (name: string) => flo.get(name)! + 1;

const versionlist = new Jagfile(new Uint8Array(fs.readFileSync('data/pack/client/versionlist')));
const config = new Jagfile(new Uint8Array(fs.readFileSync('data/pack/client/config')));
const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync('data/pack/ondemand.zip')));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const od = new OnDemand(versionlist, null as any);
LocType.unpack(config);
FloType.unpack(config);
SeqType.unpack(config); // animated locs

expect(FloType.count === flo.size, `client FloType decoded ${FloType.count} floors`);

// Fetch a map file the way the client does: map_index lookup, version and CRC
// check against the versionlist, then gunzip (minus the 2-byte version trailer).
function fetchMap(mx: number, mz: number, type: 0 | 1): Uint8Array {
    const file = od.getMapFile(mx, mz, type);
    expect(file !== -1, `client map_index has m${mx}_${mz} (${type === 0 ? 'land' : 'locs'}: file ${file})`);
    expect(od.versions[3][file] > 0, `client versionlist lists map file ${file}`);
    const data = zip[`4.${file}`];
    expect(data !== undefined, `ondemand.zip has map file ${file}`);
    expect(Packet.getcrc(data, 0, data.length - 2) === (od.crcs[3][file] | 0), `map file ${file} matches the client's CRC`);
    return new Uint8Array(zlib.gunzipSync(data.subarray(0, data.length - 2)));
}

// Build the square into a client scene the way Client.buildScene does,
// placing it at scene tile (24, 24) of the 104x104 scene.
function loadScene(mx: number, mz: number) {
    const heightmap = new Int32Array3d(4, 105, 105);
    const tileFlags = new Uint8Array3d(4, 104, 104);
    const world = new World(104, 104, heightmap, tileFlags);
    World.lowMemory = false;
    const collision = [new CollisionMap(), new CollisionMap(), new CollisionMap(), new CollisionMap()];
    const baseX = mx * 64 - 24;
    const baseZ = mz * 64 - 24;
    world.loadGround(baseX, baseZ, 24, 24, fetchMap(mx, mz, 0));
    world.loadLocations(0, null, collision, fetchMap(mx, mz, 1), 24, 24);
    return { world, collision, heightmap, tileFlags };
}

const at = (x: number, z: number) => [24 + x, 24 + z] as const;

// ---- the new square m60_50 (maps_base, patched by maps_addon) ----
expect(od.getMapFile(60, 50, 0) === ids.map.m60_50 && od.getMapFile(60, 50, 1) === ids.map.l60_50, 'client finds m60_50 at its idmap ids');
const freeIndex = od.mapIndex.indexOf((60 << 8) + 50);
expect(od.mapMembers[freeIndex] === 1, 'client prefetches m60_50 for free-to-play players');
expect(od.mapMembers[od.mapIndex.indexOf((61 << 8) + 50)] === 0, 'm61_50 (members) is not prefetched for free-to-play players');

{
    const { world, collision, heightmap, tileFlags } = loadScene(60, 50);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = world as any;
    const [wx, wz] = at(0, 0);
    expect(w.overlayType[0][wx][wz] === floor('water') && (tileFlags[0][wx][wz] & 1) === 1, 'client: border tile (0,0) is blocked water');
    const [ix, iz] = at(31, 31);
    expect(w.underlayType[0][ix][iz] === floor('grassland') && w.overlayType[0][ix][iz] === 0, 'client: tile (31,31) is grassland with no overlay');
    expect(heightmap[0][ix][iz] === 0, 'client: h1 tiles are flat (height 0)');

    const [sx, sz] = at(30, 30);
    const shrine = LocType.get(ids.loc.maps_shrine);
    expect(shrine.name === 'Fixture shrine', 'client LocType has the mod loc maps_shrine');
    expect((collision[0].flags[CollisionMap.index(sx, sz)] & CollisionFlag.LOC) !== 0, 'client: maps_shrine at (30,30) adds loc collision');
    const [tx, tz] = at(40, 40);
    expect((collision[0].flags[CollisionMap.index(tx, tz)] & CollisionFlag.LOC) !== 0, "client: maps_addon's tree2 at (40,40) adds loc collision");
    expect((collision[0].flags[CollisionMap.index(ix, iz)] & CollisionFlag.LOC) === 0, 'client: tile (31,31) has no loc');
}

// ---- the patched base square m50_50 ----
{
    const baseIds = readBasePack('map');
    expect(od.getMapFile(50, 50, 0) === baseIds.get('m50_50'), 'client finds the patched m50_50 at its base id');
    const { world, collision } = loadScene(50, 50);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = world as any;
    const [mx, mz] = at(20, 20);
    expect(w.overlayType[0][mx][mz] === floor('marble') && w.underlayType[0][mx][mz] === floor('grassland'), 'client: patched tile (20,20) is marble on grassland');
    const [sx, sz] = at(17, 41);
    expect((collision[0].flags[CollisionMap.index(sx, sz)] & CollisionFlag.LOC) !== 0, 'client: the shrine that replaced the tree at (17,41) blocks');
}

// ---- the replaced base square m29_75 ----
{
    const { world, collision } = loadScene(29, 75);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = world as any;
    const [ax, az] = at(3, 3);
    expect(w.underlayType[0][ax][az] === floor('sand'), 'client: m29_75 tile (3,3) is sand');
    const [bx, bz] = at(40, 40);
    expect(w.underlayType[0][bx][bz] === 0 && w.overlayType[0][bx][bz] === 0, 'client: m29_75 tile (40,40) is empty (the replacement only has an 8x8 area)');
    let locTiles = 0;
    for (let x = 0; x < 64; x++) {
        for (let z = 0; z < 64; z++) {
            const [cx, cz] = at(x, z);
            if (cx > 0 && cz > 0 && cx < 103 && cz < 103 && (collision[0].flags[CollisionMap.index(cx, cz)] & CollisionFlag.LOC) !== 0) {
                locTiles++;
            }
        }
    }
    expect(locTiles === 1, `client: m29_75 has exactly one blocking loc tile (got ${locTiles})`);
}

console.log('client decode checks passed');
// The client's audio helpers start browser-only timers; nothing else to wait for
process.exit(0);
