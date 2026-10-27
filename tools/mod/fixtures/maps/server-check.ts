// Loads the maps fixture build with the server's own code: World.reload()
// (configs, scripts), GameMap.init() (map squares, collision, static
// npcs/objs/locs, zone lists) and the mods' worldBoot hooks (spawns.json,
// maps report). Then checks collision and entities at fixture coordinates.
// Run by check.ts: bun tools/mod/fixtures/maps/server-check.ts
//
// Importing World starts its worker threads, so this exits explicitly.

import { CollisionFlag } from '@2004scape/rsmod-pathfinder';

import ModManager from '#/mod/ModManager.js';
import Environment from '#/util/Environment.js';
import { readBasePack, readIdMap } from '#tools/mod/Inspect.js';

// World first, as in src/app.ts: the entity modules import each other in a cycle
const { default: World } = await import('#/engine/World.js');
const { isFlagged, isZoneAllocated } = await import('#/engine/GameMap.js');
const { CoordGrid } = await import('#/engine/CoordGrid.js');
const { EntityLifeCycle } = await import('#/engine/entity/EntityLifeCycle.js');

let failures = 0;
function expect(condition: unknown, message: string) {
    if (condition) {
        console.log(`ok - ${message}`);
    } else {
        console.log(`not ok - ${message}`);
        failures++;
    }
}

try {
    const ids = readIdMap(Environment.BUILD_MODS_DIR);
    const loc = readBasePack('loc');
    const npc = readBasePack('npc');
    const obj = readBasePack('obj');
    const shrine = ids.loc.maps_shrine;
    const hermit = ids.npc.maps_hermit;
    const relic = ids.obj.maps_relic;

    World.reload();
    World.gameMap.init();
    await ModManager.runWorldBoot(World);

    const sq = (mx: number, mz: number, lx: number, lz: number) => ({ x: (mx << 6) + lx, z: (mz << 6) + lz });
    const blocked = (p: { x: number; z: number }, flag: number) => isFlagged(p.x, p.z, 0, flag);
    const npcsAt = (p: { x: number; z: number }) => Array.from(World.gameMap.getZone(p.x, p.z, 0).getAllNpcsUnsafe()).filter(n => n.x === p.x && n.z === p.z);
    const locsAt = (p: { x: number; z: number }) => Array.from(World.gameMap.getZone(p.x, p.z, 0).getLocsUnsafe(CoordGrid.packZoneCoord(p.x, p.z)));
    const objsAt = (p: { x: number; z: number }) => Array.from(World.gameMap.getZone(p.x, p.z, 0).getObjsUnsafe(CoordGrid.packZoneCoord(p.x, p.z)));

    // ---- new square m60_50 ----
    const origin = sq(60, 50, 0, 0);
    expect(isZoneAllocated(0, origin.x, origin.z) && isZoneAllocated(0, origin.x + 63, origin.z + 63), 'm60_50: collision is allocated for the new square');
    expect(blocked(sq(60, 50, 0, 0), CollisionFlag.FLOOR) && blocked(sq(60, 50, 2, 40), CollisionFlag.FLOOR), 'm60_50: the water border (f1) blocks movement');
    expect(!blocked(sq(60, 50, 31, 31), CollisionFlag.FLOOR | CollisionFlag.LOC), 'm60_50: inland tile (31,31) is walkable');
    expect(blocked(sq(60, 50, 30, 30), CollisionFlag.LOC) && locsAt(sq(60, 50, 30, 30)).some(l => l.type === shrine && l.lifecycle === EntityLifeCycle.RESPAWN), 'm60_50: maps_shrine at (30,30) is a static loc with collision');
    expect(
        locsAt(sq(60, 50, 20, 20)).some(l => l.type === loc.get('tree')),
        'm60_50: base loc tree (by name) at (20,20)'
    );
    expect(
        locsAt(sq(60, 50, 25, 25)).some(l => l.type === loc.get('tree2') && l.angle === 2),
        'm60_50: base loc 1278 (by id) at (25,25), angle 2'
    );
    expect(
        locsAt(sq(60, 50, 40, 40)).some(l => l.type === loc.get('tree2') && l.angle === 1),
        "m60_50: maps_addon's patch added tree2 at (40,40)"
    );
    expect(
        npcsAt(sq(60, 50, 32, 32)).some(n => n.type === hermit),
        'm60_50: npc maps_hermit spawned at (32,32)'
    );
    expect(
        npcsAt(sq(60, 50, 34, 34)).some(n => n.type === npc.get('man')),
        'm60_50: npc man spawned at (34,34)'
    );
    expect(
        objsAt(sq(60, 50, 33, 32)).some(o => o.type === obj.get('coins') && o.count === 25),
        'm60_50: 25 coins at (33,32)'
    );
    expect(objsAt(sq(60, 50, 35, 35)).length === 0, "m60_50: maps_addon's patch removed maps_relic at (35,35)");
    expect(World.gameMap.isFreeToPlay(origin.x, origin.z) && World.gameMap.isFreeToPlay(origin.x + 55, origin.z + 55), 'm60_50: free-to-play (maps_base free2play.csv)');
    expect(!World.gameMap.isFreeToPlay(origin.x + 56, origin.z + 56), 'm60_50: zone (56,56) is members-only (maps_addon removed it)');
    expect(World.gameMap.isMulti(CoordGrid.packCoord(0, origin.x + 24, origin.z + 24)) && !World.gameMap.isMulti(CoordGrid.packCoord(0, origin.x + 16, origin.z + 16)), 'm60_50: zone (24,24) is multiway, (16,16) is not');

    // ---- patched base square m50_50 ----
    expect(
        locsAt(sq(50, 50, 17, 41)).some(l => l.type === shrine && l.angle === 2),
        'm50_50: maps_shrine replaced the tree at (17,41)'
    );
    expect(!locsAt(sq(50, 50, 17, 41)).some(l => l.type === loc.get('tree')), 'm50_50: the base tree at (17,41) is gone');
    expect(
        locsAt(sq(50, 50, 19, 60)).some(l => l.type === loc.get('tree')),
        'm50_50: other base trees stay (19,60)'
    );
    expect(!npcsAt(sq(50, 50, 0, 38)).some(n => n.type === npc.get('giantspider1')), 'm50_50: giantspider1 at (0,38) removed');
    expect(
        npcsAt(sq(50, 50, 3, 39)).some(n => n.type === npc.get('giantspider1')),
        'm50_50: the other giantspider1 at (3,39) stays'
    );
    expect(
        npcsAt(sq(50, 50, 1, 38)).some(n => n.type === hermit),
        'm50_50: maps_hermit added at (1,38)'
    );
    expect(objsAt(sq(50, 50, 5, 27)).length === 0 && objsAt(sq(50, 50, 5, 28)).some(o => o.type === obj.get('coins') && o.count === 50), 'm50_50: bronze_arrow at (5,27) replaced by 50 coins at (5,28)');
    expect(World.gameMap.isFreeToPlay(sq(50, 50, 0, 0).x, sq(50, 50, 0, 0).z), 'm50_50: still free-to-play (base list kept)');

    // ---- replaced base square m29_75 ----
    let locCount = 0;
    for (let x = 0; x < 64; x += 8) {
        for (let z = 0; z < 64; z += 8) {
            const p = sq(29, 75, x, z);
            locCount += World.gameMap.getZone(p.x, p.z, 0).totalLocs;
        }
    }
    expect(locCount === 1 && locsAt(sq(29, 75, 4, 4)).some(l => l.type === shrine && l.angle === 3), 'm29_75: only the replacement loc (maps_shrine at (4,4)) is in the square');

    // ---- conflict m61_50: maps_addon wins ----
    expect(
        locsAt(sq(61, 50, 4, 4)).some(l => l.type === shrine),
        "m61_50: maps_addon's version (with the shrine) won"
    );

    // ---- spawns.json objs (maps_base) ----
    const coins = objsAt(sq(60, 50, 40, 30)).find(o => o.type === obj.get('coins'));
    expect(coins?.count === 100 && coins.lifecycle === EntityLifeCycle.RESPAWN && coins.respawnrate === -1, 'spawns.json: 100 coins, static, respawn after the obj respawnrate');
    const relicSpawn = objsAt(sq(60, 50, 40, 31)).find(o => o.type === relic);
    expect(relicSpawn?.lifecycle === EntityLifeCycle.RESPAWN && relicSpawn.respawnrate === 50, 'spawns.json: maps_relic, static, respawns after 50 ticks');
    const arrows = objsAt(sq(60, 50, 40, 32)).find(o => o.type === obj.get('bronze_arrow'));
    expect(arrows?.count === 5 && arrows.lifecycle === EntityLifeCycle.DESPAWN && arrows.lifecycleTick === -1, 'spawns.json: 5 bronze arrows, spawned once, no despawn timer');
    expect(
        npcsAt(sq(60, 50, 36, 36)).some(n => n.type === hermit),
        'spawns.json: npc maps_hermit at (36,36)'
    );
    expect(
        locsAt(sq(60, 50, 38, 38)).some(l => l.type === shrine && l.lifecycle === EntityLifeCycle.DESPAWN && l.angle === 1),
        'spawns.json: dynamic loc maps_shrine at (38,38), angle 1'
    );

    // A taken relic comes back after its own delay: OBJ_TAKEITEM calls removeObj with obj.respawnrate
    if (relicSpawn) {
        World.removeObj(relicSpawn, relicSpawn.respawnrate);
        expect(!relicSpawn.isActive && relicSpawn.lifecycleTick > 0 && relicSpawn.lifecycleTick <= 50, `spawns.json: a taken maps_relic is queued to respawn (in ${relicSpawn.lifecycleTick} ticks)`);
    }
} catch (err) {
    console.error(err);
    failures++;
}

console.log(failures === 0 ? 'server load checks passed' : `${failures} server load check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
