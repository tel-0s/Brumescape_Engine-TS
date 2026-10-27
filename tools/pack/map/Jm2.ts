// The .jm2 map square text format: parser, serializer and patching.
//
// A .jm2 file describes one 64x64 map square (4 levels) in sections:
//
//   ==== MAP ====              terrain, one line per tile that is not default
//   0 12 40: h30 o6;2;1 f1 u48
//   ==== LOC ====              scenery: <loc> [shape=10] [angle=0]
//   0 12 41: 1247 22 3
//   ==== NPC ====              npc spawns: <npc>
//   0 2 53: 100
//   ==== OBJ ====              obj spawns: <obj> [count=1]
//   0 5 27: 882 1
//
// Every line starts with "<level> <x> <z>:" (level 0-3, x/z 0-63 inside the
// square). MAP tokens:
//   h<n>             height (1-255; h1 is flat ground; no h means perlin noise)
//   u<floor>         underlay floor
//   o<floor>[;shape[;rotation]]   overlay floor, shape 0-11, rotation 0-3
//   f<n>             tile flags (1 block, 2 link below, 4 remove roofs,
//                    8 visible below, 16 not low detail)
// Numeric floor values are the floor id + 1 (u48 = floor id 47, grassland).
//
// Base content uses numeric ids everywhere. Mod files (src/mod/capabilities/
// maps.ts) may also use names (ugrassland, owater;2, oaktree, man, coins),
// `//` comments, and, in patches, removal lines that start with '-'.
//
// tools/pack/map/Pack.js packs the numeric form that serialize() writes.

export const SECTIONS = ['MAP', 'LOC', 'NPC', 'OBJ'] as const;
export type Jm2Section = (typeof SECTIONS)[number];

export interface Jm2Tile {
    height?: number;
    overlay?: number; // floor id + 1, as in the file
    overlayShape?: number;
    overlayRotation?: number;
    flags?: number;
    underlay?: number; // floor id + 1, as in the file
}

export interface Jm2Loc {
    level: number;
    x: number;
    z: number;
    id: number;
    shape: number;
    angle: number;
    line: number;
}

export interface Jm2Npc {
    level: number;
    x: number;
    z: number;
    id: number;
    line: number;
}

export interface Jm2Obj {
    level: number;
    x: number;
    z: number;
    id: number;
    count: number;
    line: number;
}

// A removal line in a patch ('-0 10 12: oaktree'). id -1 means '*' (all).
export interface Jm2Removal {
    section: Exclude<Jm2Section, 'MAP'>;
    level: number;
    x: number;
    z: number;
    id: number;
    shape?: number;
    angle?: number;
    count?: number;
    line: number;
    text: string;
}

export interface Jm2File {
    // tile key (packTile) -> tile; null clears the tile (patches only)
    land: Map<number, Jm2Tile | null>;
    locs: Jm2Loc[];
    npcs: Jm2Npc[];
    objs: Jm2Obj[];
    removals: Jm2Removal[];
    sections: Set<Jm2Section>;
}

// Resolves names in mod files. Each returns the config id, or -1 if unknown.
export interface Jm2Resolver {
    floor(name: string): number;
    loc(name: string): number;
    npc(name: string): number;
    obj(name: string): number;
    // Called for every numeric id (kind 'floor' gets the floor id, not id + 1).
    // Return an error message to reject it, a warning prefixed with
    // 'warn:' to accept it with a warning, or null to accept it.
    checkId?(kind: 'floor' | 'loc' | 'npc' | 'obj', id: number): string | null;
}

export interface Jm2ParseOptions {
    // Allow removal lines and empty MAP lines (patch files)
    patch?: boolean;
    // Allow names and comments (mod files); needs `resolve`
    resolve?: Jm2Resolver;
    error(line: number, message: string): Error;
    warn?(line: number, message: string): void;
}

// Limits from the packed formats (Pack.js) and the client decoder
export const MAX_UNDERLAY = 255 - 81; // opcode underlay + 81 must fit in a byte
export const MAX_OVERLAY = 255; // one byte
export const MAX_FLAGS = 81 - 49; // opcode flags + 49 must stay in 50-81
export const MAX_OVERLAY_SHAPE = 11; // opcode 2 + (shape << 2) + rotation must stay <= 49
export const MAX_LOC_SHAPE = 22;
export const MAX_OBJ_COUNT = 255; // one byte in the server obj file

export function packTile(level: number, x: number, z: number): number {
    return (level << 12) | (x << 6) | z;
}

export function unpackTile(key: number): { level: number; x: number; z: number } {
    return { level: (key >> 12) & 0x3, x: (key >> 6) & 0x3f, z: key & 0x3f };
}

export function emptyJm2(): Jm2File {
    return { land: new Map(), locs: [], npcs: [], objs: [], removals: [], sections: new Set() };
}

const SECTION_RE = /^====\s*([A-Za-z]+)\s*====$/;
const LINE_RE = /^(-)?\s*(\d+)\s+(\d+)\s+(\d+)\s*:\s*(.*)$/;
const INT_RE = /^\d+$/;

export function parseJm2(text: string, options: Jm2ParseOptions): Jm2File {
    const out = emptyJm2();
    const modFile = options.resolve !== undefined;
    const lines = text.replace(/\r/g, '').split('\n');
    const landLines = new Map<number, number>();
    let section: Jm2Section | null = null;

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        let line = lines[i];
        if (modFile) {
            const comment = line.indexOf('//');
            if (comment !== -1) {
                line = line.substring(0, comment);
            }
        }
        line = line.trim();
        if (line.length === 0) {
            continue;
        }

        const header = SECTION_RE.exec(line);
        if (header) {
            const name = header[1].toUpperCase();
            if (!(SECTIONS as readonly string[]).includes(name)) {
                throw options.error(lineNo, `Unknown section '${header[1]}' (expected one of ${SECTIONS.join(', ')})`);
            }
            section = name as Jm2Section;
            out.sections.add(section);
            continue;
        }

        if (section === null) {
            throw options.error(lineNo, 'Expected a section header such as "==== MAP ====" before the first line');
        }

        const match = LINE_RE.exec(line);
        if (!match) {
            throw options.error(lineNo, `Expected "<level> <x> <z>: ..." but got '${line}'`);
        }

        const remove = match[1] === '-';
        const level = parseInt(match[2], 10);
        const x = parseInt(match[3], 10);
        const z = parseInt(match[4], 10);
        const rest = match[5].trim();
        const args = rest.length > 0 ? rest.split(/\s+/) : [];

        if (level > 3 || x > 63 || z > 63) {
            throw options.error(lineNo, `Tile ${level} ${x} ${z} is outside the square (level 0-3, x and z 0-63)`);
        }

        if (remove && !options.patch) {
            throw options.error(lineNo, "Removal lines ('-...') are only allowed in patch files (<square>.patch.jm2)");
        }

        if (section === 'MAP') {
            if (remove) {
                throw options.error(lineNo, "MAP lines cannot be removed; write the tile with no tokens ('0 5 5:') to reset it");
            }

            const key = packTile(level, x, z);
            const previous = landLines.get(key);
            if (previous !== undefined) {
                throw options.error(lineNo, `Tile ${level} ${x} ${z} is already defined on line ${previous}`);
            }
            landLines.set(key, lineNo);

            if (args.length === 0) {
                if (!options.patch) {
                    // base content never has these; a full square has nothing to reset
                    throw options.error(lineNo, `Tile ${level} ${x} ${z} has no tokens`);
                }
                out.land.set(key, null);
                continue;
            }

            out.land.set(key, parseTile(args, lineNo, options));
            continue;
        }

        if (args.length === 0) {
            throw options.error(lineNo, `Missing the ${section.toLowerCase()} after '${level} ${x} ${z}:'`);
        }

        if (section === 'LOC') {
            const id = args[0] === '*' && remove ? -1 : resolveId('loc', args[0], lineNo, options);
            const shape = args.length > 1 ? parseIntToken(args[1], 0, MAX_LOC_SHAPE, 'loc shape', lineNo, options) : undefined;
            const angle = args.length > 2 ? parseIntToken(args[2], 0, 3, 'loc angle', lineNo, options) : undefined;
            if (args.length > 3) {
                throw options.error(lineNo, `Too many values for a loc: '${rest}' (expected <loc> [shape] [angle])`);
            }
            if (remove) {
                out.removals.push({ section, level, x, z, id, shape, angle, line: lineNo, text: line });
            } else {
                out.locs.push({ level, x, z, id, shape: shape ?? 10, angle: angle ?? 0, line: lineNo });
            }
        } else if (section === 'NPC') {
            const id = args[0] === '*' && remove ? -1 : resolveId('npc', args[0], lineNo, options);
            if (args.length > 1) {
                throw options.error(lineNo, `Too many values for an npc: '${rest}' (expected <npc>)`);
            }
            if (remove) {
                out.removals.push({ section, level, x, z, id, line: lineNo, text: line });
            } else {
                out.npcs.push({ level, x, z, id, line: lineNo });
            }
        } else {
            const id = args[0] === '*' && remove ? -1 : resolveId('obj', args[0], lineNo, options);
            const count = args.length > 1 ? parseIntToken(args[1], 1, MAX_OBJ_COUNT, 'obj count', lineNo, options) : undefined;
            if (args.length > 2) {
                throw options.error(lineNo, `Too many values for an obj: '${rest}' (expected <obj> [count])`);
            }
            if (remove) {
                out.removals.push({ section, level, x, z, id, count, line: lineNo, text: line });
            } else {
                out.objs.push({ level, x, z, id, count: count ?? 1, line: lineNo });
            }
        }
    }

    return out;
}

function parseTile(tokens: string[], line: number, options: Jm2ParseOptions): Jm2Tile {
    const tile: Jm2Tile = {};
    for (const token of tokens) {
        const type = token[0];
        const info = token.substring(1);

        if (type === 'h') {
            if (tile.height !== undefined) {
                throw options.error(line, `Height is given twice ('${token}')`);
            }
            tile.height = parseIntToken(info, 0, 255, 'height', line, options);
        } else if (type === 'u') {
            if (tile.underlay !== undefined) {
                throw options.error(line, `Underlay is given twice ('${token}')`);
            }
            tile.underlay = resolveFloor(info, MAX_UNDERLAY, 'underlay', line, options);
        } else if (type === 'o') {
            if (tile.overlay !== undefined) {
                throw options.error(line, `Overlay is given twice ('${token}')`);
            }
            const [floor, shape, rotation] = info.split(';');
            tile.overlay = resolveFloor(floor, MAX_OVERLAY, 'overlay', line, options);
            if (shape !== undefined) {
                tile.overlayShape = parseIntToken(shape, 0, MAX_OVERLAY_SHAPE, 'overlay shape', line, options);
            }
            if (rotation !== undefined) {
                tile.overlayRotation = parseIntToken(rotation, 0, 3, 'overlay rotation', line, options);
            }
        } else if (type === 'f') {
            if (tile.flags !== undefined) {
                throw options.error(line, `Flags are given twice ('${token}')`);
            }
            tile.flags = parseIntToken(info, 1, MAX_FLAGS, 'flags', line, options);
        } else {
            throw options.error(line, `Unknown terrain token '${token}' (expected h<height>, u<floor>, o<floor>[;shape[;rotation]] or f<flags>)`);
        }
    }
    return tile;
}

function parseIntToken(value: string, min: number, max: number, what: string, line: number, options: Jm2ParseOptions): number {
    if (!INT_RE.test(value)) {
        throw options.error(line, `Invalid ${what} '${value}' (expected a number ${min}-${max})`);
    }
    const n = parseInt(value, 10);
    if (n < min || n > max) {
        throw options.error(line, `${what[0].toUpperCase()}${what.substring(1)} ${n} is out of range (${min}-${max})`);
    }
    return n;
}

// Returns the value as written in the file: floor id + 1
function resolveFloor(value: string | undefined, max: number, what: string, line: number, options: Jm2ParseOptions): number {
    if (value === undefined || value.length === 0) {
        throw options.error(line, `Missing the ${what} floor`);
    }

    let fileValue: number;
    if (INT_RE.test(value)) {
        fileValue = parseInt(value, 10);
        if (fileValue < 1) {
            throw options.error(line, `${what[0].toUpperCase()}${what.substring(1)} 0 is not a floor (numeric floors are the floor id + 1)`);
        }
        checkNumeric('floor', fileValue - 1, line, options);
    } else {
        if (!options.resolve) {
            throw options.error(line, `Invalid ${what} '${value}' (expected a number)`);
        }
        const id = options.resolve.floor(value);
        if (id === -1) {
            throw options.error(line, `Unknown floor '${value}'`);
        }
        fileValue = id + 1;
    }

    if (fileValue > max) {
        throw options.error(line, `Floor ${value} (id ${fileValue - 1}) cannot be used as an ${what}: the map format allows ${what} floor ids up to ${max - 1}`);
    }
    return fileValue;
}

function resolveId(kind: 'loc' | 'npc' | 'obj', value: string, line: number, options: Jm2ParseOptions): number {
    if (INT_RE.test(value)) {
        const id = parseInt(value, 10);
        checkNumeric(kind, id, line, options);
        return id;
    }
    if (!options.resolve) {
        throw options.error(line, `Invalid ${kind} id '${value}' (expected a number)`);
    }
    const id = options.resolve[kind](value);
    if (id === -1) {
        throw options.error(line, `Unknown ${kind} '${value}'`);
    }
    return id;
}

function checkNumeric(kind: 'floor' | 'loc' | 'npc' | 'obj', id: number, line: number, options: Jm2ParseOptions) {
    const problem = options.resolve?.checkId?.(kind, id) ?? null;
    if (problem === null) {
        return;
    }
    if (problem.startsWith('warn:')) {
        options.warn?.(line, problem.substring(5).trim());
        return;
    }
    throw options.error(line, problem);
}

// Applies a patch file to a square in place: MAP lines replace whole tiles,
// removal lines run before additions, and a removal that matches nothing is
// an error (the base square probably changed).
export function applyJm2Patch(square: Jm2File, patch: Jm2File, error: (line: number, message: string) => Error): void {
    for (const [key, tile] of patch.land) {
        if (tile === null) {
            square.land.delete(key);
        } else {
            square.land.set(key, tile);
        }
    }

    for (const removal of patch.removals) {
        const at = (e: { level: number; x: number; z: number }) => e.level === removal.level && e.x === removal.x && e.z === removal.z;
        const idMatches = (id: number) => removal.id === -1 || removal.id === id;
        let removed = 0;

        if (removal.section === 'LOC') {
            const keep = square.locs.filter(l => !(at(l) && idMatches(l.id) && (removal.shape === undefined || removal.shape === l.shape) && (removal.angle === undefined || removal.angle === l.angle)));
            removed = square.locs.length - keep.length;
            square.locs = keep;
        } else if (removal.section === 'NPC') {
            const keep = square.npcs.filter(n => !(at(n) && idMatches(n.id)));
            removed = square.npcs.length - keep.length;
            square.npcs = keep;
        } else {
            const keep = square.objs.filter(o => !(at(o) && idMatches(o.id) && (removal.count === undefined || removal.count === o.count)));
            removed = square.objs.length - keep.length;
            square.objs = keep;
        }

        if (removed === 0) {
            throw error(removal.line, `'${removal.text}' matches no ${removal.section.toLowerCase()} in the square`);
        }
    }

    square.locs.push(...patch.locs);
    square.npcs.push(...patch.npcs);
    square.objs.push(...patch.objs);
}

function byTile(a: { level: number; x: number; z: number }, b: { level: number; x: number; z: number }): number {
    return packTile(a.level, a.x, a.z) - packTile(b.level, b.x, b.z);
}

function tileTokens(tile: Jm2Tile): string {
    const tokens: string[] = [];
    if (tile.height !== undefined) {
        tokens.push(`h${tile.height}`);
    }
    if (tile.overlay !== undefined) {
        let token = `o${tile.overlay}`;
        if (tile.overlayShape !== undefined || tile.overlayRotation !== undefined) {
            token += `;${tile.overlayShape ?? 0}`;
        }
        if (tile.overlayRotation !== undefined) {
            token += `;${tile.overlayRotation}`;
        }
        tokens.push(token);
    }
    if (tile.flags !== undefined) {
        tokens.push(`f${tile.flags}`);
    }
    if (tile.underlay !== undefined) {
        tokens.push(`u${tile.underlay}`);
    }
    return tokens.join(' ');
}

// The numeric form that Pack.js reads. Lines are sorted by tile; entries on
// the same tile keep their order.
export function serializeJm2(square: Jm2File): string {
    const out: string[] = ['==== MAP ===='];
    const land = Array.from(square.land.entries())
        .filter((e): e is [number, Jm2Tile] => e[1] !== null)
        .sort((a, b) => a[0] - b[0]);
    for (const [key, tile] of land) {
        const tokens = tileTokens(tile);
        if (tokens.length === 0) {
            continue;
        }
        const { level, x, z } = unpackTile(key);
        out.push(`${level} ${x} ${z}: ${tokens}`);
    }

    out.push('==== LOC ====');
    for (const loc of [...square.locs].sort(byTile)) {
        out.push(`${loc.level} ${loc.x} ${loc.z}: ${loc.id} ${loc.shape} ${loc.angle}`);
    }

    out.push('==== NPC ====');
    for (const npc of [...square.npcs].sort(byTile)) {
        out.push(`${npc.level} ${npc.x} ${npc.z}: ${npc.id}`);
    }

    out.push('==== OBJ ====');
    for (const obj of [...square.objs].sort(byTile)) {
        out.push(`${obj.level} ${obj.x} ${obj.z}: ${obj.id} ${obj.count}`);
    }

    return out.join('\n') + '\n';
}

// 'm60_50' -> { x: 60, z: 50 }; null if the name is not a map square
export function parseSquareName(name: string): { x: number; z: number } | null {
    const match = /^m(\d+)_(\d+)$/.exec(name);
    if (!match) {
        return null;
    }
    const x = parseInt(match[1], 10);
    const z = parseInt(match[2], 10);
    if (x > 255 || z > 255) {
        return null;
    }
    return { x, z };
}
