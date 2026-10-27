// Capability: maps and new lands.
//
// Mod layout (all under <mod>/maps/, subfolders allowed):
//   m<x>_<z>.jm2         a whole map square: a new square at unused
//                        coordinates, or a replacement of the base square
//   m<x>_<z>.patch.jm2   changes to an existing square (base or an earlier
//                        mod's): MAP lines replace single tiles, LOC/NPC/OBJ
//                        lines add entries, lines starting with '-' remove
//                        entries (tools/pack/map/Jm2.ts has the format)
//   free2play.csv        zones (or whole squares) to add to, or with '-'
//   multiway.csv         remove from, the base free-to-play/multiway lists
//
// Mod map files may use names (oaktree, man, coins, ugrassland) as well as
// ids. Names of mod content must be used by name: mod ids come from the
// install's idmap.json and differ between installs.
//
// How it works:
//   afterRevalidate  every build: register new squares in MapPack (stable ids,
//                    contiguous after base content), point the 'map' asset of
//                    every touched square at its staged file, record the
//                    outputs of new squares, merge the zone CSVs.
//   before.maps      all config names are registered by now: resolve names,
//                    apply replacements and patches in load order and write
//                    the numeric .jm2 to data/pack/mods/maps/ (only when it
//                    changed, so incremental builds skip unchanged squares).
//   Pack.js          packs ModManager.getAssets('map') over base content.
//   worldBoot        logs what the server loaded for each mod square.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { MAP_CSV_NAMES, mergedMapCsvPath } from '#/engine/MapCsv.js';
import type { MapCsvName } from '#/engine/MapCsv.js';
import Environment from '#/util/Environment.js';
import { printInfo } from '#/util/Logger.js';
import { applyJm2Patch, parseJm2, parseSquareName, serializeJm2 } from '#tools/pack/map/Jm2.js';
import type { Jm2File, Jm2Resolver } from '#tools/pack/map/Jm2.js';
import { FloPack, LocPack, MapPack, NpcPack, ObjPack } from '#tools/pack/PackFile.js';
import type { PackFile } from '#tools/pack/PackFileBase.js';

interface SquareStep {
    file: ModFile;
    patch: boolean;
    order: number; // mod index in load order
}

interface SquarePlan {
    name: string; // 'm60_50'
    x: number;
    z: number;
    base: string | null; // the content .jm2, if base content has this square
    steps: SquareStep[]; // load order; within a mod the full square before its patch
    staged: string;
}

// Plans of the build in progress (rebuilt in afterRevalidate)
let plans = new Map<string, SquarePlan>();

function baseSquarePath(name: string): string {
    return path.join(Environment.BUILD_SRC_DIR, 'maps', `${name}.jm2`);
}

// Output files of one square (see tools/pack/map/Pack.js)
function squareOutputs(x: number, z: number): string[] {
    return [`data/pack/client/maps/m${x}_${z}`, `data/pack/client/maps/l${x}_${z}`, ...['m', 'l', 'n', 'o'].map(t => `data/pack/server/maps/${t}${x}_${z}`)];
}

function collectPlans(): Map<string, SquarePlan> {
    const out = new Map<string, SquarePlan>();
    const seen = new Map<string, ModFile>();
    const order = new Map(ModManager.mods.map((mod, i) => [mod, i]));
    const staging = ModManager.stagingDir('maps');

    for (const file of ModManager.listFiles('maps', '.jm2')) {
        const patch = file.name.endsWith('.patch');
        const name = patch ? file.name.substring(0, file.name.length - '.patch'.length) : file.name;
        const square = parseSquareName(name);
        if (!square) {
            throw ModManager.error(file, null, 'Map files must be named m<x>_<z>.jm2 (a whole square) or m<x>_<z>.patch.jm2 (a patch), with x and z 0-255, e.g. m60_50.jm2');
        }

        const key = `${file.mod.name}\t${name}\t${patch}`;
        const twice = seen.get(key);
        if (twice) {
            throw ModManager.error(file, null, `${name} ${patch ? 'is patched' : 'is defined'} twice in this mod (also in ${twice.relPath})`);
        }
        seen.set(key, file);

        let plan = out.get(name);
        if (!plan) {
            const base = baseSquarePath(name);
            plan = { name, x: square.x, z: square.z, base: fs.existsSync(base) ? base : null, steps: [], staged: path.join(staging, `${name}.jm2`) };
            out.set(name, plan);
        }
        plan.steps.push({ file, patch, order: order.get(file.mod)! });
    }

    for (const plan of out.values()) {
        plan.steps.sort((a, b) => a.order - b.order || Number(a.patch) - Number(b.patch));

        let defined = plan.base !== null;
        for (const step of plan.steps) {
            if (step.patch && !defined) {
                throw ModManager.error(step.file, null, `Patch for ${plan.name}, but neither base content nor an earlier mod defines that square. Name the file ${plan.name}.jm2 to add a new square.`);
            }
            if (!step.patch) {
                defined = true;
                ModManager.claim('map', plan.name, step.file);
            }
        }
    }

    return out;
}

function makeResolver(): Jm2Resolver {
    const packs: Record<'floor' | 'loc' | 'npc' | 'obj', PackFile> = { floor: FloPack, loc: LocPack, npc: NpcPack, obj: ObjPack };
    return {
        floor: name => FloPack.getByName(name),
        loc: name => LocPack.getByName(name),
        npc: name => NpcPack.getByName(name),
        obj: name => ObjPack.getByName(name),
        checkId(kind, id) {
            const pack = packs[kind];
            const name = pack.getById(id);
            if (!name) {
                return `${kind} id ${id} does not exist`;
            }
            if (pack.modNames.has(name)) {
                return `warn: ${kind} id ${id} is '${name}' from a mod. Mod ids differ between installs: write the name instead.`;
            }
            return null;
        }
    };
}

// The square after every mod's replacement and patch, in load order
function buildSquare(plan: SquarePlan, resolve: Jm2Resolver): { square: Jm2File; from: string; patchedBy: string[] } {
    let square: Jm2File | null = null;
    let from = 'base content';
    let patchedBy: string[] = [];

    if (plan.base) {
        const base = plan.base;
        square = parseJm2(fs.readFileSync(base, 'utf-8'), {
            error: (line, message) => new Error(`${base}:${line}: ${message}`)
        });
    }

    for (const step of plan.steps) {
        const file = step.file;
        const options = {
            patch: step.patch,
            resolve,
            error: (line: number, message: string) => ModManager.error(file, line, message),
            warn: (line: number, message: string) => ModManager.warn(file, line, message)
        };
        const parsed = parseJm2(fs.readFileSync(file.path, 'utf-8'), options);

        if (!step.patch) {
            if (patchedBy.length > 0) {
                ModManager.warn(file, null, `replaces ${plan.name} as a whole, so earlier patches from ${patchedBy.join(', ')} no longer apply`);
            }
            if (!parsed.sections.has('MAP')) {
                ModManager.warn(file, null, 'has no MAP section: every tile of the square has no floor');
            }
            square = parsed;
            from = file.mod.name;
            patchedBy = [];
        } else {
            applyJm2Patch(square!, parsed, (line, message) => ModManager.error(file, line, message));
            patchedBy.push(file.mod.name);
        }
    }

    return { square: square!, from, patchedBy };
}

// ---- zone lists (free2play.csv, multiway.csv) ----

const ZONE_RE = /^(-)?\s*(\d+)_(\d+)_(\d+)(?:_(\d+)_(\d+))?$/;
const BASE_ZONE_RE = /^(\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/;

function mergeZoneCsv(name: MapCsvName, files: ModFile[]): { lines: string[]; added: number; removed: number } {
    const zones = new Map<string, true>();
    const other: string[] = [];
    let added = 0;
    let removed = 0;

    const basePath = path.join(Environment.BUILD_SRC_DIR, 'maps', name);
    const baseLines = fs.existsSync(basePath) ? fs.readFileSync(basePath, 'ascii').replace(/\r/g, '').split('\n') : [];
    for (const raw of baseLines) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('//')) {
            continue;
        }
        const match = BASE_ZONE_RE.exec(line);
        if (match) {
            zones.set(match.slice(1, 6).map(Number).join('_'), true);
        } else {
            other.push(line);
        }
    }

    for (const file of files) {
        const lines = fs.readFileSync(file.path, 'utf-8').replace(/\r/g, '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const comment = lines[i].indexOf('//');
            const line = (comment === -1 ? lines[i] : lines[i].substring(0, comment)).trim();
            if (line.length === 0) {
                continue;
            }

            const match = ZONE_RE.exec(line);
            if (!match) {
                throw ModManager.error(file, i + 1, `Expected <level>_<mapx>_<mapz> (a whole square) or <level>_<mapx>_<mapz>_<localx>_<localz> (one 8x8 zone), optionally after '-' to remove, but got '${line}'`);
            }

            const remove = match[1] === '-';
            const [level, mx, mz] = [match[2], match[3], match[4]].map(Number);
            if (level > 3 || mx > 255 || mz > 255) {
                throw ModManager.error(file, i + 1, `'${line}' is out of range (level 0-3, map square x and z 0-255)`);
            }

            const keys: string[] = [];
            if (match[5] === undefined) {
                for (let lx = 0; lx < 64; lx += 8) {
                    for (let lz = 0; lz < 64; lz += 8) {
                        keys.push(`${level}_${mx}_${mz}_${lx}_${lz}`);
                    }
                }
            } else {
                const lx = Number(match[5]);
                const lz = Number(match[6]);
                if (lx > 63 || lz > 63 || lx % 8 !== 0 || lz % 8 !== 0) {
                    throw ModManager.error(file, i + 1, `Zone '${line}' must start at a multiple of 8 inside the square (local x and z: 0, 8, ..., 56)`);
                }
                keys.push(`${level}_${mx}_${mz}_${lx}_${lz}`);
            }

            let changed = 0;
            for (const key of keys) {
                if (remove && zones.delete(key)) {
                    changed++;
                } else if (!remove && !zones.has(key)) {
                    zones.set(key, true);
                    changed++;
                }
            }
            if (remove) {
                removed += changed;
                if (changed === 0) {
                    ModManager.warn(file, i + 1, `'${line}' removes nothing: no such zone in ${name}`);
                }
            } else {
                added += changed;
            }
        }
    }

    const header = [`// Generated by the mod loader (src/mod/capabilities/maps.ts): base ${name} plus mod changes. Do not edit.`];
    return { lines: [...header, ...other, ...zones.keys()], added, removed };
}

function writeZoneCsvs() {
    const files = ModManager.listFiles('maps', '.csv');
    for (const file of files) {
        if (!(MAP_CSV_NAMES as readonly string[]).includes(file.subPath)) {
            throw ModManager.error(file, null, `Unknown map list '${file.subPath}': mods can only have maps/${MAP_CSV_NAMES.join(' and maps/')}`);
        }
    }

    for (const name of MAP_CSV_NAMES) {
        const out = mergedMapCsvPath(name);
        const mine = files.filter(f => f.subPath === name);
        if (mine.length === 0) {
            fs.rmSync(out, { force: true });
            continue;
        }

        const { lines, added, removed } = mergeZoneCsv(name, mine);
        const text = lines.join('\n') + '\n';
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (!fs.existsSync(out) || fs.readFileSync(out, 'ascii') !== text) {
            fs.writeFileSync(out, text);
        }
        ModManager.recordOutput(out);
        printInfo(`[mods] maps: ${name}: ${added} zone(s) added, ${removed} removed (${Array.from(new Set(mine.map(f => f.mod.name))).join(', ')})`);
    }
}

// ---- capability ----

const capability: ModCapability = {
    name: 'maps',

    afterRevalidate() {
        // MapPack is not in revalidatePack(): reset it here so mod squares of an
        // earlier build in this process (dev watcher) do not linger.
        MapPack.reload();

        plans = collectPlans();

        for (const plan of plans.values()) {
            if (plan.base === null) {
                // A new square: stable ids for its land and loc files
                ModManager.registerName('map', MapPack, `m${plan.x}_${plan.z}`);
                ModManager.registerName('map', MapPack, `l${plan.x}_${plan.z}`);
                for (const output of squareOutputs(plan.x, plan.z)) {
                    ModManager.recordOutput(output);
                }
            } else if (MapPack.getByName(`m${plan.x}_${plan.z}`) === -1) {
                throw new Error(`[mods] maps: base square ${plan.name} has no id in ${Environment.BUILD_SRC_DIR}/pack/map.pack`);
            }
            ModManager.setAsset('map', plan.name, plan.staged);
        }

        writeZoneCsvs();
    },

    before: {
        maps() {
            const staging = ModManager.stagingDir('maps');
            const keep = new Set(Array.from(plans.values()).map(p => path.basename(p.staged)));
            for (const entry of fs.readdirSync(staging)) {
                if (!keep.has(entry)) {
                    fs.rmSync(path.join(staging, entry), { recursive: true, force: true });
                }
            }

            const resolve = makeResolver();
            for (const plan of plans.values()) {
                const { square, from, patchedBy } = buildSquare(plan, resolve);
                const text = serializeJm2(square);
                if (!fs.existsSync(plan.staged) || fs.readFileSync(plan.staged, 'utf-8') !== text) {
                    fs.writeFileSync(plan.staged, text);
                }

                const what = plan.base === null ? 'new square' : from === 'base content' ? 'base square' : 'replaces the base square';
                const by = from === 'base content' ? '' : ` from ${from}`;
                const patches = patchedBy.length > 0 ? `, patched by ${patchedBy.join(', ')}` : '';
                printInfo(`[mods] maps: ${plan.name} (${what}${by}${patches}): ${square.land.size} tiles, ${square.locs.length} locs, ${square.npcs.length} npcs, ${square.objs.length} objs`);
            }
        }
    },

    // Reports what the server loaded for every square a mod adds or changes
    async worldBoot(world) {
        const squares = new Map<string, { x: number; z: number; mods: Set<string>; base: boolean }>();
        for (const file of ModManager.listFiles('maps', '.jm2')) {
            const name = file.name.replace(/\.patch$/, '');
            const square = parseSquareName(name);
            if (!square) {
                continue;
            }
            const entry = squares.get(name) ?? { ...square, mods: new Set<string>(), base: fs.existsSync(baseSquarePath(name)) };
            entry.mods.add(file.mod.name);
            squares.set(name, entry);
        }
        if (squares.size === 0) {
            return;
        }

        const { isFlagged, isZoneAllocated } = await import('#/engine/GameMap.js');
        const { CollisionFlag } = await import('@2004scape/rsmod-pathfinder');

        for (const [name, square] of squares) {
            const originX = square.x << 6;
            const originZ = square.z << 6;
            let locs = 0;
            let objs = 0;
            let npcs = 0;
            let zones = 0;
            let blocked = 0;

            for (let level = 0; level < 4; level++) {
                for (let zx = 0; zx < 64; zx += 8) {
                    for (let zz = 0; zz < 64; zz += 8) {
                        if (!isZoneAllocated(level, originX + zx, originZ + zz)) {
                            continue;
                        }
                        zones++;
                        const zone = world.gameMap.getZone(originX + zx, originZ + zz, level);
                        locs += zone.totalLocs;
                        objs += zone.totalObjs;
                        for (const _npc of zone.getAllNpcsUnsafe()) {
                            npcs++;
                        }
                        for (let x = 0; x < 8; x++) {
                            for (let z = 0; z < 8; z++) {
                                if (isFlagged(originX + zx + x, originZ + zz + z, level, CollisionFlag.FLOOR | CollisionFlag.LOC | CollisionFlag.WALL_NORTH | CollisionFlag.WALL_EAST | CollisionFlag.WALL_SOUTH | CollisionFlag.WALL_WEST)) {
                                    blocked++;
                                }
                            }
                        }
                    }
                }
            }

            const kind = square.base ? 'changed base square' : 'new square';
            if (zones === 0) {
                printInfo(`[mods] maps: ${name} (${kind}, ${Array.from(square.mods).join(', ')}) is not loaded${Environment.NODE_MEMBERS ? '' : ' on this free-to-play world (add it to maps/free2play.csv)'}`);
            } else {
                printInfo(`[mods] maps: ${name} (${kind}, ${Array.from(square.mods).join(', ')}): ${zones} zones with collision, ${blocked} blocked tiles, ${locs} locs, ${objs} objs, ${npcs} npcs`);
            }
        }
    }
};

export default capability;
