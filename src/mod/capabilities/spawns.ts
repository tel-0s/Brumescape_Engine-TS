// Capability: world spawns.
//
// Mod layout: spawns.json at the mod root:
//   {
//     "npcs": [{ "id": "<npc name>", "coord": "level_mapx_mapz_localx_localz" }],
//     "locs": [{ "id": "<loc name>", "coord": "...", "shape": 10, "angle": 0 }]
//   }
// Placed on world boot: npcs as RESPAWN entities (they respawn after death),
// locs as permanent dynamic locs (mod locs are not in the client's map data,
// so a static loc would never render).

import fs from 'fs';
import path from 'path';

import { LocAngle, LocShape } from '@2004scape/rsmod-pathfinder';

import { EntityLifeCycle } from '#/engine/entity/EntityLifeCycle.js';
import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';
import { printInfo } from '#/util/Logger.js';

interface SpawnManifest {
    npcs?: { id: string; coord: string }[];
    locs?: { id: string; coord: string; shape?: number; angle?: number }[];
}

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

const capability: ModCapability = {
    name: 'spawns',

    async worldBoot(world) {
        // Runtime-only modules: imported here, not at the top of the file,
        // because the build process loads every capability too.
        const { default: Npc } = await import('#/engine/entity/Npc.js');
        const { default: Loc } = await import('#/engine/entity/Loc.js');
        const { default: NpcType } = await import('#/cache/config/NpcType.js');
        const { default: LocType } = await import('#/cache/config/LocType.js');

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

            for (const spawn of manifest.npcs ?? []) {
                const at = parseModCoord(spawn.coord);
                const type = NpcType.getByName(spawn.id);
                if (!at || !type) {
                    ModManager.warn(mod, null, `spawns.json: bad npc spawn (id='${spawn.id}', coord='${spawn.coord}')`);
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

            if (npcCount || locCount) {
                printInfo(`[mods] ${mod.name}: spawned ${npcCount} npc(s), ${locCount} loc(s)`);
            }
        }
    }
};

export default capability;
