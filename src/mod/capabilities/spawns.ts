// Capability: world spawns.
//
// Mod layout: spawns.json at the mod root:
//   {
//     "npcs": [{ "id": "<npc name>", "coord": "level_mapx_mapz_localx_localz" }],
//     "locs": [{ "id": "<loc name>", "coord": "...", "shape": 10, "angle": 0 }],
//     "objs": [{ "id": "<obj name>", "coord": "...", "count": 1, "respawn": true }]
//   }
// Checked at build time (unknown names, bad coords and values fail the
// build) and placed on world boot:
//   npcs  RESPAWN entities: they respawn after death (npc respawnrate).
//   locs  permanent dynamic locs. They are not in the client's map data, so
//         the server sends them to each player. For scenery that should be
//         part of the map, put it in a map square or patch instead
//         (src/mod/capabilities/maps.ts): those locs render statically.
//   objs  "respawn": true (default) makes a static obj like the objs in map
//         squares: it comes back <obj respawnrate> ticks after it is taken.
//         A number of ticks overrides the delay for this spawn. false spawns
//         it once per server start: once taken, it is gone until a restart.
// On a free-to-play world (NODE_MEMBERS=false), npcs and objs outside
// free-to-play zones, and members npcs and objs, are skipped, as for map
// squares.

import fs from 'fs';
import path from 'path';

import { LocAngle, LocShape } from '@2004scape/rsmod-pathfinder';

import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
import ModManager from '#/mod/ModManager.js';
import type { Mod, ModCapability, ModFile } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';
import { printInfo } from '#/util/Logger.js';
import { LocPack, NpcPack, ObjPack } from '#tools/pack/PackFile.js';

interface NpcSpawn {
    id: string;
    coord: string;
}

interface LocSpawn {
    id: string;
    coord: string;
    shape?: number;
    angle?: number;
}

interface ObjSpawn {
    id: string;
    coord: string;
    count?: number;
    respawn?: boolean | number;
}

interface SpawnManifest {
    npcs?: NpcSpawn[];
    locs?: LocSpawn[];
    objs?: ObjSpawn[];
}

const SECTION_KEYS: Record<keyof SpawnManifest, string[]> = {
    npcs: ['id', 'coord'],
    locs: ['id', 'coord', 'shape', 'angle'],
    objs: ['id', 'coord', 'count', 'respawn']
};

// "level_mapx_mapz_localx_localz" -> absolute coords
export function parseModCoord(coord: string): { level: number; x: number; z: number } | null {
    const parts = coord.split('_').map(n => parseInt(n, 10));
    if (parts.length !== 5 || parts.some(n => Number.isNaN(n))) {
        return null;
    }
    const [level, mx, mz, lx, lz] = parts;
    if (level < 0 || level > 3 || mx < 0 || mx > 255 || mz < 0 || mz > 255 || lx < 0 || lx > 63 || lz < 0 || lz > 63) {
        return null;
    }
    return { level, x: (mx << 6) + lx, z: (mz << 6) + lz };
}

function spawnsFile(mod: Mod): ModFile | null {
    const file = path.join(mod.dir, 'spawns.json');
    if (!fs.existsSync(file)) {
        return null;
    }
    return { mod, path: file, relPath: 'spawns.json', subPath: 'spawns.json', name: 'spawns', ext: '.json' };
}

// 1-based line of the first occurrence of `needle` in `text`, or null
function lineOf(text: string, needle: string): number | null {
    const index = text.indexOf(needle);
    return index === -1 ? null : text.substring(0, index).split('\n').length;
}

function isInt(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// Build-time validation: every problem is a ModError with the entry's line
function validateSpawns(file: ModFile) {
    const text = fs.readFileSync(file.path, 'utf-8');
    let manifest: unknown;
    try {
        manifest = JSON.parse(text);
    } catch (err) {
        throw ModManager.error(file, null, `invalid JSON: ${err instanceof Error ? err.message : err}`);
    }

    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        throw ModManager.error(file, null, 'expected an object with "npcs", "locs" and/or "objs" arrays');
    }

    for (const [section, entries] of Object.entries(manifest)) {
        const allowed = SECTION_KEYS[section as keyof SpawnManifest];
        if (!allowed) {
            throw ModManager.error(file, lineOf(text, `"${section}"`), `unknown key "${section}" (expected npcs, locs or objs)`);
        }
        if (!Array.isArray(entries)) {
            throw ModManager.error(file, lineOf(text, `"${section}"`), `"${section}" must be an array`);
        }

        entries.forEach((entry: Record<string, unknown>, i: number) => {
            const where = `${section}[${i}]`;
            const line = typeof entry?.coord === 'string' ? lineOf(text, `"${entry.coord}"`) : lineOf(text, `"${section}"`);
            const fail = (message: string) => ModManager.error(file, line, `${where}: ${message}`);

            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                throw fail('expected an object');
            }
            for (const key of Object.keys(entry)) {
                if (!allowed.includes(key)) {
                    throw fail(`unknown key "${key}" (expected ${allowed.join(', ')})`);
                }
            }
            if (typeof entry.id !== 'string') {
                throw fail('"id" must be a name');
            }
            if (typeof entry.coord !== 'string' || parseModCoord(entry.coord) === null) {
                throw fail(`"coord" must be "level_mapx_mapz_localx_localz" (level 0-3, map square 0-255, local 0-63), got ${JSON.stringify(entry.coord)}`);
            }

            if (section === 'npcs' && NpcPack.getByName(entry.id) === -1) {
                throw fail(`unknown npc '${entry.id}'`);
            } else if (section === 'locs') {
                if (LocPack.getByName(entry.id) === -1) {
                    throw fail(`unknown loc '${entry.id}'`);
                }
                if (entry.shape !== undefined && !isInt(entry.shape, 0, 22)) {
                    throw fail('"shape" must be a loc shape 0-22');
                }
                if (entry.angle !== undefined && !isInt(entry.angle, 0, 3)) {
                    throw fail('"angle" must be 0-3 (0 west, 1 north, 2 east, 3 south)');
                }
            } else if (section === 'objs') {
                if (ObjPack.getByName(entry.id) === -1) {
                    throw fail(`unknown obj '${entry.id}'`);
                }
                if (entry.count !== undefined && !isInt(entry.count, 1, 0x7fffffff)) {
                    throw fail('"count" must be a whole number of at least 1');
                }
                if (entry.respawn !== undefined && typeof entry.respawn !== 'boolean' && !isInt(entry.respawn, 1, 0x7fffffff)) {
                    throw fail('"respawn" must be true, false or a number of ticks (at least 1)');
                }
            }
        });
    }
}

const capability: ModCapability = {
    name: 'spawns',

    // Every config name is registered by now (afterRevalidate)
    beforeSymbols() {
        for (const mod of ModManager.mods) {
            const file = spawnsFile(mod);
            if (file) {
                validateSpawns(file);
            }
        }
    },

    async worldBoot(world) {
        // Runtime-only modules: imported here, not at the top of the file,
        // because the build process loads every capability too.
        const { default: Npc } = await import('#/engine/entity/Npc.js');
        const { default: Loc } = await import('#/engine/entity/Loc.js');
        const { default: Obj } = await import('#/engine/entity/Obj.js');
        const { default: NpcType } = await import('#/cache/config/NpcType.js');
        const { default: LocType } = await import('#/cache/config/LocType.js');
        const { default: ObjType } = await import('#/cache/config/ObjType.js');

        const freeWorld = !Environment.NODE_MEMBERS;

        for (const mod of ModManager.mods) {
            const file = path.join(mod.dir, 'spawns.json');
            if (!fs.existsSync(file)) {
                continue;
            }

            let manifest: SpawnManifest;
            try {
                manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
            } catch (err) {
                ModManager.warn(mod, null, `invalid spawns.json: ${err}`);
                continue;
            }

            let npcCount = 0;
            let locCount = 0;
            let objCount = 0;
            let skipped = 0;

            for (const spawn of manifest.npcs ?? []) {
                const at = parseModCoord(spawn.coord);
                const type = NpcType.getByName(spawn.id);
                if (!at || !type) {
                    ModManager.warn(mod, null, `spawns.json: bad npc spawn (id='${spawn.id}', coord='${spawn.coord}')`);
                    continue;
                }
                if (freeWorld && (type.members || !world.gameMap.isFreeToPlay(at.x, at.z))) {
                    skipped++;
                    continue;
                }
                const npc = new Npc(at.level, at.x, at.z, type.size, type.size, EntityLifeCycle.RESPAWN, world.getNextNid(), type.id, type.moverestrict, type.blockwalk);
                world.addNpc(npc, -1);
                npcCount++;
            }

            for (const spawn of manifest.locs ?? []) {
                const at = parseModCoord(spawn.coord);
                const type = LocType.getByName(spawn.id);
                if (!at || !type) {
                    ModManager.warn(mod, null, `spawns.json: bad loc spawn (id='${spawn.id}', coord='${spawn.coord}')`);
                    continue;
                }
                const shape = spawn.shape ?? LocShape.CENTREPIECE_STRAIGHT;
                const angle = spawn.angle ?? LocAngle.WEST;
                // Dynamic (DESPAWN) loc via addLoc: broadcast now and delivered to
                // players entering the zone later; duration -1 keeps it
                // untracked, i.e. permanent. addLoc handles collision.
                world.addLoc(new Loc(at.level, at.x, at.z, type.width, type.length, EntityLifeCycle.DESPAWN, type.id, shape, angle), -1);
                locCount++;
            }

            for (const spawn of manifest.objs ?? []) {
                const at = parseModCoord(spawn.coord);
                const type = ObjType.getByName(spawn.id);
                const count = spawn.count ?? 1;
                const respawn = spawn.respawn ?? true;
                if (!at || !type || count < 1) {
                    ModManager.warn(mod, null, `spawns.json: bad obj spawn (id='${spawn.id}', coord='${spawn.coord}')`);
                    continue;
                }
                if (freeWorld && (type.members || !world.gameMap.isFreeToPlay(at.x, at.z))) {
                    skipped++;
                    continue;
                }
                if (respawn === false) {
                    // Untracked dynamic obj: stays until someone takes it, never respawns
                    world.addObj(new Obj(at.level, at.x, at.z, EntityLifeCycle.DESPAWN, type.id, count), Obj.NO_RECEIVER, -1);
                } else {
                    // Static obj, like the OBJ section of a map square
                    const obj = new Obj(at.level, at.x, at.z, EntityLifeCycle.RESPAWN, type.id, count);
                    if (typeof respawn === 'number') {
                        obj.respawnrate = respawn;
                    }
                    world.gameMap.getZone(at.x, at.z, at.level).addStaticObj(obj);
                }
                objCount++;
            }

            if (npcCount || locCount || objCount || skipped) {
                printInfo(`[mods] ${mod.name}: spawned ${npcCount} npc(s), ${locCount} loc(s), ${objCount} obj(s)${skipped ? `; skipped ${skipped} outside free-to-play on this free world` : ''}`);
            }
        }
    }
};

export default capability;
