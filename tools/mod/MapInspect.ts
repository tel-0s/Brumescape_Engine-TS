// Read packed map squares back (for fixture checks and `bun run mod:inspect map`).
//
// The decoders follow the formats the client (dash3d/World.ts loadGround,
// loadLocations) and the server (engine/GameMap.ts) read. They do not share
// code with the packer (tools/pack/map/Pack.js), so a check that uses them
// tests the packed bytes, not the packer against itself.

import fs from 'fs';

import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { PACK_DIR, readCache, readCacheGunzip } from '#tools/mod/Inspect.js';
import type { Jm2File, Jm2Tile } from '#tools/pack/map/Jm2.js';

export interface PackedTile {
    height: number | null; // null: perlin noise
    overlay: number; // floor id + 1, 0 = none
    overlayShape: number;
    overlayRotation: number;
    flags: number;
    underlay: number; // floor id + 1, 0 = none
}

export interface PackedLoc {
    id: number;
    level: number;
    x: number;
    z: number;
    shape: number;
    angle: number;
}

export interface PackedSpawn {
    id: number;
    level: number;
    x: number;
    z: number;
    count: number; // 1 for npcs
}

export interface PackedSquare {
    tiles: PackedTile[]; // index (level << 12) | (x << 6) | z
    locs: PackedLoc[];
    npcs: PackedSpawn[];
    objs: PackedSpawn[];
}

export interface MapIndexEntry {
    x: number;
    z: number;
    land: number; // cache archive 4 file id
    loc: number;
    free: boolean; // prefetched for free-to-play players
}

export function tileIndex(level: number, x: number, z: number): number {
    return (level << 12) | (x << 6) | z;
}

export function decodeLand(data: Uint8Array): PackedTile[] {
    const buf = new Packet(data);
    const tiles: PackedTile[] = [];
    for (let level = 0; level < 4; level++) {
        for (let x = 0; x < 64; x++) {
            for (let z = 0; z < 64; z++) {
                const tile: PackedTile = { height: null, overlay: 0, overlayShape: 0, overlayRotation: 0, flags: 0, underlay: 0 };
                for (;;) {
                    const opcode = buf.g1();
                    if (opcode === 0) {
                        break;
                    }
                    if (opcode === 1) {
                        tile.height = buf.g1();
                        break;
                    }
                    if (opcode <= 49) {
                        tile.overlay = buf.g1();
                        tile.overlayShape = (opcode - 2) >> 2;
                        tile.overlayRotation = (opcode - 2) & 0x3;
                    } else if (opcode <= 81) {
                        tile.flags = opcode - 49;
                    } else {
                        tile.underlay = opcode - 81;
                    }
                }
                tiles[tileIndex(level, x, z)] = tile;
            }
        }
    }
    if (buf.pos !== data.length) {
        throw new Error(`land data has ${data.length - buf.pos} trailing bytes`);
    }
    return tiles;
}

export function decodeLocs(data: Uint8Array): PackedLoc[] {
    const buf = new Packet(data);
    const locs: PackedLoc[] = [];
    let id = -1;
    for (;;) {
        const deltaId = buf.gsmarts();
        if (deltaId === 0) {
            break;
        }
        id += deltaId;
        let pos = 0;
        for (;;) {
            const deltaPos = buf.gsmarts();
            if (deltaPos === 0) {
                break;
            }
            pos += deltaPos - 1;
            const info = buf.g1();
            locs.push({ id, level: (pos >> 12) & 0x3, x: (pos >> 6) & 0x3f, z: pos & 0x3f, shape: info >> 2, angle: info & 0x3 });
        }
    }
    if (buf.pos !== data.length) {
        throw new Error(`loc data has ${data.length - buf.pos} trailing bytes`);
    }
    return locs;
}

// Server npc (n) and obj (o) files: <pos:2> <count:1> then per entry <id:2> (+ <count:1> for objs)
export function decodeSpawns(data: Uint8Array, objs: boolean): PackedSpawn[] {
    const buf = new Packet(data);
    const out: PackedSpawn[] = [];
    while (buf.pos < data.length) {
        const pos = buf.g2();
        const n = buf.g1();
        for (let i = 0; i < n; i++) {
            const id = buf.g2();
            const count = objs ? buf.g1() : 1;
            out.push({ id, level: (pos >> 12) & 0x3, x: (pos >> 6) & 0x3f, z: pos & 0x3f, count });
        }
    }
    return out;
}

function readFile(file: string): Uint8Array {
    return new Uint8Array(fs.readFileSync(file));
}

// What the server loads (data/pack/server/maps/{m,l,n,o}<x>_<z>), or null
export function readServerSquare(mx: number, mz: number): PackedSquare | null {
    const dir = `${PACK_DIR}/server/maps`;
    if (!fs.existsSync(`${dir}/m${mx}_${mz}`)) {
        return null;
    }
    return {
        tiles: decodeLand(readFile(`${dir}/m${mx}_${mz}`)),
        locs: decodeLocs(readFile(`${dir}/l${mx}_${mz}`)),
        npcs: decodeSpawns(readFile(`${dir}/n${mx}_${mz}`), false),
        objs: decodeSpawns(readFile(`${dir}/o${mx}_${mz}`), true)
    };
}

// The versionlist's map_index (cache archive 0 file 5): what the client looks up
export function readMapIndex(): MapIndexEntry[] {
    const data = readCache(0, 5);
    if (!data) {
        throw new Error('cache 0/5 (versionlist) is missing');
    }
    const index = new Jagfile(new Packet(data)).read('map_index');
    if (!index) {
        throw new Error('versionlist has no map_index');
    }
    const out: MapIndexEntry[] = [];
    const length = index.data.length;
    while (index.pos + 7 <= length) {
        const region = index.g2();
        out.push({ x: region >> 8, z: region & 0xff, land: index.g2(), loc: index.g2(), free: index.g1() === 1 });
    }
    return out;
}

// What the client gets for a square (cache archive 4 via map_index), or null
export function readClientSquare(mx: number, mz: number): { entry: MapIndexEntry; tiles: PackedTile[]; locs: PackedLoc[] } | null {
    const entry = readMapIndex().find(e => e.x === mx && e.z === mz);
    if (!entry) {
        return null;
    }
    const land = readCacheGunzip(4, entry.land);
    const locs = readCacheGunzip(4, entry.loc);
    if (!land || !locs) {
        throw new Error(`m${mx}_${mz}: map_index points at cache files ${entry.land}/${entry.loc}, which are missing`);
    }
    return { entry, tiles: decodeLand(land), locs: decodeLocs(locs) };
}

// `bun run mod:inspect map <square> [level x z]`
export function inspectMapCli(args: string[]) {
    const match = /^m?(\d+)[_,](\d+)$/.exec(args[0] ?? '');
    if (!match) {
        throw new Error('usage: map <square> [<level> <x> <z>], e.g. map m60_50 0 30 30');
    }
    const mx = Number(match[1]);
    const mz = Number(match[2]);
    const server = readServerSquare(mx, mz);
    const client = readClientSquare(mx, mz);
    if (!server && !client) {
        console.log(`m${mx}_${mz}: not packed`);
        process.exitCode = 1;
        return;
    }
    if (client) {
        console.log(`client: map_index land=${client.entry.land} loc=${client.entry.loc} free=${client.entry.free}, ${client.locs.length} locs`);
    } else {
        console.log('client: not in map_index');
    }
    if (server) {
        const tiles = server.tiles.filter(t => t.height !== null || t.overlay || t.flags || t.underlay).length;
        console.log(`server: ${tiles} non-default tiles, ${server.locs.length} locs, ${server.npcs.length} npcs, ${server.objs.length} objs`);
    }
    if (args.length >= 4 && server) {
        const [level, x, z] = args.slice(1, 4).map(Number);
        const at = (e: { level: number; x: number; z: number }) => e.level === level && e.x === x && e.z === z;
        console.log(`tile ${level} ${x} ${z}:`, JSON.stringify(server.tiles[tileIndex(level, x, z)]));
        server.locs.filter(at).forEach(l => console.log(`  loc ${l.id} shape ${l.shape} angle ${l.angle}`));
        server.npcs.filter(at).forEach(n => console.log(`  npc ${n.id}`));
        server.objs.filter(at).forEach(o => console.log(`  obj ${o.id} x${o.count}`));
    }
}

// What a parsed .jm2 should decode to once packed (Pack.js semantics: h0 is
// perlin noise, a shape without an overlay is dropped). Locs, npcs and objs are
// sorted, so compare them with sortSquare(decoded).
export function expectedFromJm2(jm2: Jm2File): PackedSquare {
    const tiles: PackedTile[] = [];
    for (let i = 0; i < 4 * 64 * 64; i++) {
        const tile: Jm2Tile | null | undefined = jm2.land.get(i);
        tiles[i] = {
            height: tile?.height ? tile.height : null,
            overlay: tile?.overlay ?? 0,
            overlayShape: tile?.overlay ? (tile.overlayShape ?? 0) : 0,
            overlayRotation: tile?.overlay ? (tile.overlayRotation ?? 0) : 0,
            flags: tile?.flags ?? 0,
            underlay: tile?.underlay ?? 0
        };
    }
    return sortSquare({
        tiles,
        locs: jm2.locs.map(l => ({ id: l.id, level: l.level, x: l.x, z: l.z, shape: l.shape, angle: l.angle })),
        npcs: jm2.npcs.map(n => ({ id: n.id, level: n.level, x: n.x, z: n.z, count: 1 })),
        objs: jm2.objs.map(o => ({ id: o.id, level: o.level, x: o.x, z: o.z, count: o.count }))
    });
}

export function sortSquare(square: PackedSquare): PackedSquare {
    const key = (e: { id: number; level: number; x: number; z: number }) => (((e.level << 12) | (e.x << 6) | e.z) << 16) + e.id;
    const sorted = <T extends { id: number; level: number; x: number; z: number }>(list: T[]) => [...list].sort((a, b) => key(a) - key(b) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { tiles: square.tiles, locs: sorted(square.locs), npcs: sorted(square.npcs), objs: sorted(square.objs) };
}
