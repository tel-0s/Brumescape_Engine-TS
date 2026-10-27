// Read back what a build produced in data/pack and data/symbols.
//
// CLI:  bun run mod:inspect <command> [args]   (see USAGE below)
// API:  import { ... } from '#tools/mod/Inspect.js' in a fixture's check.ts
//
// Everything here only reads build output. It never imports the world or the
// packers, so it is safe to run while nothing else is going on.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import FileStream from '#/io/FileStream.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { discoverMods } from '#/mod/ModDiscovery.js';
import Environment from '#/util/Environment.js';

export const PACK_DIR = 'data/pack';
export const SYMBOL_DIR = 'data/symbols';

// Cache archive 0 files (the client "jag" archives)
export const ARCHIVE0 = ['', 'title', 'config', 'interface', 'media', 'versionlist', 'textures', 'wordenc', 'sounds'];

interface ConfigClass {
    load(dir: string): void;
    getByName(name: string): object | null;
}

// Config type name -> loader class (server side, from data/pack/server)
const CONFIG_CLASSES: Record<string, () => Promise<ConfigClass>> = {
    npc: async () => (await import('#/cache/config/NpcType.js')).default,
    obj: async () => (await import('#/cache/config/ObjType.js')).default,
    loc: async () => (await import('#/cache/config/LocType.js')).default,
    seq: async () => (await import('#/cache/config/SeqType.js')).default,
    spotanim: async () => (await import('#/cache/config/SpotanimType.js')).default,
    idk: async () => (await import('#/cache/config/IdkType.js')).default,
    enum: async () => (await import('#/cache/config/EnumType.js')).default,
    struct: async () => (await import('#/cache/config/StructType.js')).default,
    hunt: async () => (await import('#/cache/config/HuntType.js')).default,
    mesanim: async () => (await import('#/cache/config/MesanimType.js')).default,
    varp: async () => (await import('#/cache/config/VarPlayerType.js')).default,
    varn: async () => (await import('#/cache/config/VarNpcType.js')).default,
    vars: async () => (await import('#/cache/config/VarSharedType.js')).default,
    param: async () => (await import('#/cache/config/ParamType.js')).default,
    inv: async () => (await import('#/cache/config/InvType.js')).default,
    flo: async () => (await import('#/cache/config/FloType.js')).default,
    dbtable: async () => (await import('#/cache/config/DbTableType.js')).default,
    dbrow: async () => (await import('#/cache/config/DbRowType.js')).default,
    category: async () => (await import('#/cache/config/CategoryType.js')).default
};

export const CONFIG_TYPE_NAMES = Object.keys(CONFIG_CLASSES);

const loaded = new Set<string>();

// The decoded server-side config `name` of `type` ('npc', 'obj', ...), or null
export async function getConfig(type: string, name: string): Promise<Record<string, unknown> | null> {
    const getClass = CONFIG_CLASSES[type];
    if (!getClass) {
        throw new Error(`Unknown config type '${type}' (known: ${CONFIG_TYPE_NAMES.join(', ')})`);
    }
    if (!loaded.has('param')) {
        // other types decode params through ParamType
        (await CONFIG_CLASSES.param()).load(PACK_DIR);
        loaded.add('param');
    }
    const cls = await getClass();
    if (!loaded.has(type)) {
        cls.load(PACK_DIR);
        loaded.add(type);
    }
    return cls.getByName(name) as Record<string, unknown> | null;
}

// data/symbols/<file>.sym as name -> id (first column)
export function readSymbols(file: string): Map<string, number> {
    const out = new Map<string, number>();
    const symPath = path.join(SYMBOL_DIR, `${file}.sym`);
    if (!fs.existsSync(symPath)) {
        throw new Error(`${symPath} does not exist (build first)`);
    }
    for (const line of fs.readFileSync(symPath, 'utf-8').split('\n')) {
        if (!line) {
            continue;
        }
        const [id, name] = line.split('\t');
        out.set(name, parseInt(id, 10));
    }
    return out;
}

// One file of the client cache, as stored (archive 0 = jag files, 1 = models,
// 2 = anims, 3 = midi, 4 = maps; 1-4 are gzipped)
export function readCache(archive: number, file: number): Uint8Array | null {
    const cache = new FileStream(PACK_DIR, false, true);
    return cache.read(archive, file);
}

export function cacheCount(archive: number): number {
    return new FileStream(PACK_DIR, false, true).count(archive);
}

// A gzipped cache file (archives 1-4) decompressed, or null
export function readCacheGunzip(archive: number, file: number): Uint8Array | null {
    const data = readCache(archive, file);
    if (!data) {
        return null;
    }
    // ondemand files carry a 2-byte version trailer after the gzip stream
    return new Uint8Array(zlib.gunzipSync(data.subarray(0, data.length - 2)));
}

// One entry of an archive-0 jag file (e.g. readJagEntry(1, 'logo.dat'))
export function readJagEntry(file: number, entry: string): Uint8Array | null {
    const data = readCache(0, file);
    if (!data) {
        return null;
    }
    const jag = new Jagfile(new Packet(data));
    const packet = jag.read(entry);
    return packet ? packet.data.subarray(0, packet.data.length) : null;
}

export function crc(data: Uint8Array): number {
    return Packet.getcrc(data, 0, data.length);
}

// The CRC table the server sends (/crc): one CRC per archive-0 file
export function crcTable(): number[] {
    const out: number[] = [];
    const count = cacheCount(0);
    for (let i = 0; i < count; i++) {
        const data = readCache(0, i);
        out.push(data ? crc(data) : 0);
    }
    return out;
}

// Compiled scripts in data/pack/server/script.dat: name -> { id, source }
export function readCompiledScripts(): Map<string, { id: number; source: string }> {
    const dat = Packet.load(`${PACK_DIR}/server/script.dat`);
    const idx = Packet.load(`${PACK_DIR}/server/script.idx`);
    const out = new Map<string, { id: number; source: string }>();

    const entries = dat.g4s();
    idx.pos += 4;
    dat.g4s(); // compiler version

    for (let id = 0; id < entries; id++) {
        const size = idx.g4s();
        if (size === 0) {
            continue;
        }
        const data = new Uint8Array(size);
        dat.gdata(data, 0, size);
        const script = new Packet(data);
        const name = script.gjstr(0);
        const source = script.gjstr(0);
        out.set(name, { id, source });
    }
    return out;
}

// name -> id of base content, from ${BUILD_SRC_DIR}/pack/<type>.pack
export function readBasePack(type: string): Map<string, number> {
    const out = new Map<string, number>();
    const file = path.join(Environment.BUILD_SRC_DIR, 'pack', `${type}.pack`);
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            out.set(line.substring(eq + 1), parseInt(line.substring(0, eq), 10));
        }
    }
    return out;
}

// Throws with `message` unless `condition` holds (for check.ts files)
export function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(`check failed: ${message}`);
    }
    console.log(`ok - ${message}`);
}

export function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
    return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

// The mods dir's idmap.json (kind -> name -> id)
export function readIdMap(modsDir: string = Environment.BUILD_MODS_DIR): Record<string, Record<string, number>> {
    const file = path.join(modsDir, 'idmap.json');
    if (!fs.existsSync(file)) {
        return {};
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { ids: Record<string, number> }>;
    const out: Record<string, Record<string, number>> = {};
    for (const [kind, entry] of Object.entries(raw)) {
        out[kind] = entry.ids;
    }
    return out;
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: bun run mod:inspect <command> [args]

Reads the output of the last build (data/pack, data/symbols).

  order                      mods in load order (BUILD_MODS_DIR, default mods)
  config <type> <name>       decoded server config, e.g. config npc jemery_mclabe
                             types: ${CONFIG_TYPE_NAMES.join(', ')}
  sym <file> [filter]        rows of data/symbols/<file>.sym containing filter
  script <filter>            compiled scripts in script.dat whose name contains filter
  cache <archive> <file>     size and CRC of a cache file (archive 0 lists its jag entries)
  count <archive>            number of files in a cache archive
  crc                        the CRC table served at /crc
  ids [kind]                 idmap.json of BUILD_MODS_DIR
  state                      mod build fingerprint and recorded outputs
  map <square> [<level> <x> <z>]   a packed map square as client and server get it`;

function replacer(_key: string, value: unknown) {
    if (value instanceof Map) {
        return Object.fromEntries(value);
    }
    if (value instanceof Uint8Array || value instanceof Int32Array || value instanceof Uint16Array) {
        return Array.from(value);
    }
    return value;
}

async function cli(args: string[]) {
    const [command, ...rest] = args;

    switch (command) {
        case 'order': {
            const { mods, disabled, warnings } = discoverMods(Environment.BUILD_MODS_DIR);
            warnings.forEach(w => console.log(`warning: ${w}`));
            mods.forEach((m, i) => console.log(`${i + 1}. ${m.name} v${m.manifest.version}  ${m.dir}`));
            disabled.forEach(m => console.log(`-  ${m.name} (disabled)`));
            break;
        }
        case 'config': {
            const [type, name] = rest;
            if (!type || !name) {
                throw new Error('usage: config <type> <name>');
            }
            const config = await getConfig(type, name);
            if (!config) {
                console.log(`${type} '${name}' not found in ${PACK_DIR}/server`);
                process.exitCode = 1;
                return;
            }
            console.log(JSON.stringify(config, replacer, 2));
            break;
        }
        case 'sym': {
            const [file, filter = ''] = rest;
            for (const [name, id] of readSymbols(file)) {
                if (name.includes(filter)) {
                    console.log(`${id}\t${name}`);
                }
            }
            break;
        }
        case 'script': {
            const [filter = ''] = rest;
            for (const [name, { id, source }] of readCompiledScripts()) {
                if (name.includes(filter)) {
                    console.log(`${id}\t${name}\t${source}`);
                }
            }
            break;
        }
        case 'cache': {
            const archive = parseInt(rest[0], 10);
            const file = parseInt(rest[1], 10);
            const data = readCache(archive, file);
            if (!data) {
                console.log(`cache ${archive}/${file}: missing`);
                process.exitCode = 1;
                return;
            }
            console.log(`cache ${archive}/${file}${archive === 0 ? ` (${ARCHIVE0[file] ?? '?'})` : ''}: ${data.length} bytes, crc ${crc(data)}`);
            if (archive === 0 && file > 0) {
                const jag = new Jagfile(new Packet(data));
                for (let i = 0; i < jag.fileCount; i++) {
                    const entry = jag.get(i);
                    const label = jag.fileName[i] ?? `hash ${jag.fileHash[i]}`;
                    console.log(`  ${label}: ${entry ? `${entry.data.length} bytes, crc ${crc(entry.data)}` : 'empty'}`);
                }
            }
            break;
        }
        case 'count':
            console.log(cacheCount(parseInt(rest[0], 10)));
            break;
        case 'crc':
            crcTable().forEach((value, i) => console.log(`${i}\t${ARCHIVE0[i] || '-'}\t${value}`));
            break;
        case 'ids': {
            const map = readIdMap();
            const [kind] = rest;
            console.log(JSON.stringify(kind ? (map[kind] ?? {}) : map, null, 2));
            break;
        }
        case 'state': {
            const file = path.join(PACK_DIR, 'mods', 'state.json');
            console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : 'no state (no successful build yet)');
            break;
        }
        case 'map':
            (await import('#tools/mod/MapInspect.js')).inspectMapCli(rest);
            break;
        default:
            console.log(USAGE);
            if (command && command !== 'help') {
                process.exitCode = 1;
            }
    }
}

if (import.meta.main) {
    await cli(process.argv.slice(2)).catch(err => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    });
}
