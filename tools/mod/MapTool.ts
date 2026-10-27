// `bun run mod map ...`: starting points for map squares in a mod.
// The format is described in tools/pack/map/Jm2.ts; the loader side is
// src/mod/capabilities/maps.ts.
//
// This tool only reads base content and mod folders. It never imports the
// packers (they save content/pack/*.pack on import).

import fs from 'fs';
import path from 'path';

import kleur from 'kleur';

import { findInstalledMods, listModTree } from '#/mod/ModDiscovery.js';
import type { Mod } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';

export const MAP_USAGE = `  map new <mod> <square> [options]
                    scaffold a new map square, e.g. map new MyMod m60_50 --water 3
                      --underlay <floor>   ground floor (default grassland)
                      --overlay <floor>    paint every land tile with this floor
                      --height <h>         flat (default), perlin (rolling hills) or 1-255
                      --water <n>          a border of n water tiles (blocked)
                      --free               add the square to the mod's maps/free2play.csv
                      --force              overwrite the mod's file if it exists
  map copy <mod> <square>     copy a base square into the mod to replace it
  map patch <mod> <square>    start a patch: add or remove locs, npcs, objs, tiles
  map grid                    show which map squares base content and mods use`;

const MODS_DIR = Environment.BUILD_MODS_DIR;

interface Options {
    underlay: string;
    overlay: string | null;
    height: string;
    water: number;
    free: boolean;
    force: boolean;
}

function fail(message: string): never {
    throw new Error(message);
}

function parseSquare(arg: string | undefined): { x: number; z: number; name: string } {
    const match = arg ? /^m?(\d+)[_,](\d+)$/.exec(arg) : null;
    if (!match) {
        fail(`Expected a map square like m60_50, got '${arg ?? ''}'`);
    }
    const x = parseInt(match[1], 10);
    const z = parseInt(match[2], 10);
    if (x > 255 || z > 255) {
        fail(`Map square ${arg} is out of range (x and z 0-255)`);
    }
    return { x, z, name: `m${x}_${z}` };
}

function findMod(name: string | undefined): Mod {
    if (!name) {
        fail('Missing the mod name');
    }
    const mods = findInstalledMods(MODS_DIR);
    const mod = mods.find(m => m.name === name || path.basename(m.dir) === name);
    if (!mod) {
        fail(`No mod '${name}' in ${MODS_DIR}. Installed: ${mods.map(m => m.name).join(', ') || '(none)'}. Create one with \`bun run mod create\`.`);
    }
    return mod;
}

function baseSquarePath(name: string): string {
    return path.join(Environment.BUILD_SRC_DIR, 'maps', `${name}.jm2`);
}

function listJm2(dir: string): string[] {
    return fs.existsSync(dir) ? listModTree(dir).filter(file => file.endsWith('.jm2')) : [];
}

// Mods (other than `except`) with a file for this square
function modsUsing(name: string, except?: Mod): string[] {
    return findInstalledMods(MODS_DIR)
        .filter(m => m !== except && m.dir !== except?.dir)
        .filter(m => listJm2(path.join(m.dir, 'maps')).some(f => path.basename(f).replace(/(\.patch)?\.jm2$/, '') === name))
        .map(m => m.name);
}

// Floor names from base content (pack/flo.pack) and every installed mod's .flo configs
function floorNames(): Set<string> {
    const names = new Set<string>();
    const pack = path.join(Environment.BUILD_SRC_DIR, 'pack', 'flo.pack');
    if (fs.existsSync(pack)) {
        for (const line of fs.readFileSync(pack, 'utf-8').split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) {
                names.add(line.substring(eq + 1).trim());
            }
        }
    }
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) {
            return;
        }
        for (const file of listModTree(dir).filter(f => f.endsWith('.flo'))) {
            for (const match of fs.readFileSync(file, 'utf-8').matchAll(/^\[([^\]]+)\]/gm)) {
                names.add(match[1]);
            }
        }
    };
    for (const mod of findInstalledMods(MODS_DIR)) {
        walk(path.join(mod.dir, 'config'));
    }
    return names;
}

function checkFloor(name: string, floors: Set<string>) {
    if (!floors.has(name)) {
        fail(
            `Unknown floor '${name}'. Base floors include grassland, muddygrass, lightgrass, sand, desert1, mud1, lightrock, darkrock (underlays) and grass, road, water, woodenfloor, marble (overlays); see ${Environment.BUILD_SRC_DIR}/scripts/floors/.`
        );
    }
}

function writeFile(file: string, text: string, force: boolean) {
    if (fs.existsSync(file) && !force) {
        fail(`${file} already exists (use --force to overwrite)`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(kleur.green(`Wrote ${file}`));
}

function addFreeToPlay(mod: Mod, x: number, z: number) {
    const file = path.join(mod.dir, 'maps', 'free2play.csv');
    const line = `0_${x}_${z}`;
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '// Free-to-play zones: <level>_<mapx>_<mapz> (whole square) or <level>_<mapx>_<mapz>_<localx>_<localz> (one 8x8 zone)\n';
    if (existing.split('\n').some(l => l.trim() === line)) {
        return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, existing + (existing.endsWith('\n') ? '' : '\n') + line + '\n');
    console.log(kleur.green(`Added ${line} to ${file}`));
}

function parseOptions(args: string[]): Options {
    const options: Options = { underlay: 'grassland', overlay: null, height: 'flat', water: 0, free: false, force: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const value = () => args[++i] ?? fail(`${arg} needs a value`);
        if (arg === '--underlay') {
            options.underlay = value();
        } else if (arg === '--overlay') {
            options.overlay = value();
        } else if (arg === '--height') {
            options.height = value();
        } else if (arg === '--water') {
            options.water = parseInt(value(), 10);
            if (!(options.water >= 0 && options.water <= 32)) {
                fail('--water must be 0-32 tiles');
            }
        } else if (arg === '--free') {
            options.free = true;
        } else if (arg === '--force') {
            options.force = true;
        } else {
            fail(`Unknown option '${arg}'`);
        }
    }
    if (options.height !== 'flat' && options.height !== 'perlin' && !/^\d+$/.test(options.height)) {
        fail(`--height must be flat, perlin or a number 1-255, got '${options.height}'`);
    }
    if (/^\d+$/.test(options.height) && (parseInt(options.height, 10) < 1 || parseInt(options.height, 10) > 255)) {
        fail('--height must be 1-255');
    }
    return options;
}

function newSquare(args: string[]) {
    const mod = findMod(args[0]);
    const square = parseSquare(args[1]);
    const options = parseOptions(args.slice(2));

    if (fs.existsSync(baseSquarePath(square.name))) {
        fail(`${square.name} is a base content square. Use \`bun run mod map copy ${mod.name} ${square.name}\` to replace it, or \`bun run mod map patch ${mod.name} ${square.name}\` to change parts of it.`);
    }
    const others = modsUsing(square.name, mod);
    if (others.length > 0) {
        console.log(kleur.yellow(`Note: ${others.join(', ')} also define ${square.name}. The mod that loads last wins.`));
    }

    const floors = floorNames();
    checkFloor(options.underlay, floors);
    if (options.overlay) {
        checkFloor(options.overlay, floors);
    }

    const height = options.height === 'perlin' ? null : options.height === 'flat' ? 1 : parseInt(options.height, 10);
    const lines = [
        `// ${square.name}: a new map square, made by \`bun run mod map new\`.`,
        '// Lines are "<level> <x> <z>: ..." with x and z 0-63 inside the square.',
        '// MAP tokens: h<height> (h1 = flat), u<floor> (underlay), o<floor>[;shape[;rotation]] (overlay), f<flags> (1 = blocked).',
        '// Floors, locs, npcs and objs can be written by name (ugrassland, oaktree, man, coins).',
        `// In game: ::tele 0,${square.x},${square.z},32,32`,
        '==== MAP ===='
    ];
    for (let x = 0; x < 64; x++) {
        for (let z = 0; z < 64; z++) {
            const water = Math.min(x, z, 63 - x, 63 - z) < options.water;
            const tokens: string[] = [];
            if (water) {
                tokens.push('h1', 'owater', 'f1');
            } else {
                if (height !== null) {
                    tokens.push(`h${height}`);
                }
                if (options.overlay) {
                    tokens.push(`o${options.overlay}`);
                }
            }
            tokens.push(`u${options.underlay}`);
            lines.push(`0 ${x} ${z}: ${tokens.join(' ')}`);
        }
    }
    lines.push('==== LOC ====', '// 0 30 30: oaktree 10 0     <loc> [shape] [angle]', '==== NPC ====', '// 0 32 32: man               <npc>', '==== OBJ ====', '// 0 33 32: coins 25          <obj> [count]', '');

    writeFile(path.join(mod.dir, 'maps', `${square.name}.jm2`), lines.join('\n'), options.force);
    if (options.free) {
        addFreeToPlay(mod, square.x, square.z);
    } else {
        console.log(kleur.gray(`${square.name} is members-only. Add 0_${square.x}_${square.z} to ${path.join(mod.dir, 'maps', 'free2play.csv')} (or pass --free) to make it free-to-play.`));
    }
    console.log(`Rebuild (bun run build), then ::tele 0,${square.x},${square.z},32,32 in game.`);
}

function copySquare(args: string[]) {
    const mod = findMod(args[0]);
    const square = parseSquare(args[1]);
    const force = args.includes('--force');
    const base = baseSquarePath(square.name);
    if (!fs.existsSync(base)) {
        fail(`Base content has no ${square.name}. Use \`bun run mod map new ${mod.name} ${square.name}\` for a new square.`);
    }
    const header = `// ${square.name}: copied from base content by \`bun run mod map copy\`. This file replaces the base square as a whole.\n`;
    writeFile(path.join(mod.dir, 'maps', `${square.name}.jm2`), header + fs.readFileSync(base, 'utf-8'), force);
}

function patchSquare(args: string[]) {
    const mod = findMod(args[0]);
    const square = parseSquare(args[1]);
    const force = args.includes('--force');
    const base = fs.existsSync(baseSquarePath(square.name));
    const others = modsUsing(square.name, mod);
    if (!base && others.length === 0) {
        console.log(kleur.yellow(`Neither base content nor another installed mod has ${square.name}: the patch only works if a mod that loads earlier adds it.`));
    }
    const lines = [
        `// Patch for ${square.name}. Everything not listed here stays as it is.`,
        '//   MAP lines replace the terrain of one tile:      0 10 10: h1 ugrassland',
        '//   LOC, NPC and OBJ lines add entries:              0 10 11: oaktree 10 0',
        "//   Lines starting with '-' remove matching entries: -0 10 12: 1276   (or '*' for all on that tile)",
        '//   Removals run before additions. A removal that matches nothing fails the build.',
        `// In game: ::tele 0,${square.x},${square.z},32,32`,
        '==== MAP ====',
        '==== LOC ====',
        '==== NPC ====',
        '==== OBJ ====',
        ''
    ];
    writeFile(path.join(mod.dir, 'maps', `${square.name}.patch.jm2`), lines.join('\n'), force);
}

function grid() {
    const used = new Map<string, string>();
    const mark = (x: number, z: number, c: string) => used.set(`${x}_${z}`, c);
    const mapsDir = path.join(Environment.BUILD_SRC_DIR, 'maps');
    for (const file of fs.existsSync(mapsDir) ? fs.readdirSync(mapsDir) : []) {
        const match = /^m(\d+)_(\d+)\.jm2$/.exec(file);
        if (match) {
            mark(Number(match[1]), Number(match[2]), '#');
        }
    }
    for (const mod of findInstalledMods(MODS_DIR)) {
        for (const file of listJm2(path.join(mod.dir, 'maps'))) {
            const match = /^m(\d+)_(\d+)(\.patch)?\.jm2$/.exec(path.basename(file));
            if (match) {
                const key = `${match[1]}_${match[2]}`;
                mark(Number(match[1]), Number(match[2]), used.has(key) ? '*' : '+');
            }
        }
    }
    if (used.size === 0) {
        console.log('No map squares found.');
        return;
    }

    const xs = Array.from(used.keys()).map(k => Number(k.split('_')[0]));
    const zs = Array.from(used.keys()).map(k => Number(k.split('_')[1]));
    const minX = Math.max(0, Math.min(...xs) - 2);
    const maxX = Math.min(255, Math.max(...xs) + 2);
    console.log('# base square   + new mod square   * base square a mod replaces or patches   . unused');
    console.log('Surface squares have z < 100; z >= 100 are underground (dungeons are at z + 100).');
    for (let z = Math.max(...zs); z >= Math.min(...zs); z--) {
        let row = '';
        for (let x = minX; x <= maxX; x++) {
            row += used.get(`${x}_${z}`) ?? '.';
        }
        if (/[#+*]/.test(row)) {
            console.log(`z ${String(z).padStart(3)}  ${row}`);
        }
    }
    let axis = '';
    for (let x = minX; x <= maxX; x++) {
        axis += x % 10 === 0 ? '|' : String(x % 10);
    }
    console.log(`       ${axis}   (x from ${minX} to ${maxX}; '|' marks multiples of 10)`);
}

export async function mapCommand(args: string[]) {
    const [command, ...rest] = args;
    switch (command) {
        case 'new':
            return newSquare(rest);
        case 'copy':
            return copySquare(rest);
        case 'patch':
            return patchSquare(rest);
        case 'grid':
            return grid();
        default:
            console.log(`Usage: bun run mod map <command>\n\n${MAP_USAGE}`);
            if (command && command !== 'help') {
                process.exitCode = 1;
            }
    }
}
