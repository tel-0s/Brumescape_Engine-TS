// Read back packed interfaces and media sprites (capability B).
//
// CLI:  bun tools/mod/InspectInterfaces.ts interface <name>   an interface and its components
//       bun tools/mod/InspectInterfaces.ts component <iface:com>
//       bun tools/mod/InspectInterfaces.ts sprite <name>       every tile of a media sprite
// API:  import { ... } from '#tools/mod/InspectInterfaces.js' in a fixture's check.ts
//
// Uses the engine's decoders: src/cache/config/Component.ts reads the client
// interface archive (data/pack/client/interface) plus the names in
// data/pack/server/interface.dat; src/cache/graphics/Pix.ts reads sprites from
// the media archive in the client cache (archive 0 file 4), like the client.

import Component from '#/cache/config/Component.js';
import Pix from '#/cache/graphics/Pix.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { PACK_DIR, readCache } from '#tools/mod/Inspect.js';

let loaded = false;

function load() {
    if (!loaded) {
        Component.load(PACK_DIR);
        loaded = true;
    }
}

// A decoded component (or interface root) by name, or null
export function getComponent(name: string): Component | null {
    load();
    return Component.getByName(name);
}

// Name of a component id, or null
export function componentName(id: number): string | null {
    load();
    return Component.get(id)?.comName ?? null;
}

// The children of a layer as { name, x, y }
export function children(layer: Component): { name: string; x: number; y: number }[] {
    const out: { name: string; x: number; y: number }[] = [];
    if (!layer.childId || !layer.childX || !layer.childY) {
        return out;
    }
    for (let i = 0; i < layer.childId.length; i++) {
        // childX/childY are stored as Uint16; positions can be negative
        out.push({ name: componentName(layer.childId[i]) ?? String(layer.childId[i]), x: (layer.childX[i] << 16) >> 16, y: (layer.childY[i] << 16) >> 16 });
    }
    return out;
}

// Every component id of an interface (its root first), in archive order
export function interfaceComponents(name: string): Component[] {
    load();
    const root = Component.getByName(name);
    if (!root) {
        return [];
    }
    const out: Component[] = [];
    for (let id = 0; id < 0x10000; id++) {
        const com = Component.get(id);
        if (com && com.rootLayer === root.id) {
            out.push(com);
        }
    }
    return out;
}

let media: Jagfile | null = null;

// The media archive (cache archive 0 file 4)
export function readMedia(): Jagfile {
    if (!media) {
        const data = readCache(0, 4);
        if (!data) {
            throw new Error('the cache has no media archive (build first)');
        }
        media = new Jagfile(new Packet(data));
    }
    return media;
}

// One tile of a media sprite, or null past the last tile
export function readSprite(name: string, tile: number = 0): Pix | null {
    return Pix.unpackJag(readMedia(), name, tile);
}

// All tiles of a media sprite
export function readSpriteTiles(name: string): Pix[] {
    const tiles: Pix[] = [];
    for (let i = 0; i < 1000; i++) {
        const pix = readSprite(name, i);
        if (!pix) {
            break;
        }
        tiles.push(pix);
    }
    return tiles;
}

// RGB of the first opaque pixel of a decoded tile (0 when it is empty)
export function firstColour(pix: Pix): number {
    const index = pix.pixels.find(p => p !== 0);
    return index === undefined ? 0 : pix.palette[index];
}

function describe(com: Component) {
    const fields: Record<string, unknown> = {
        id: com.id,
        name: com.comName,
        root: componentName(com.rootLayer),
        overlay: com.overlay,
        type: com.comType,
        buttonType: com.buttonType,
        width: com.width,
        height: com.height
    };
    if (com.comType === Component.TYPE_LAYER) {
        fields.scroll = com.scroll;
        fields.hide = com.hide;
        fields.children = children(com).map(c => `${c.name}@${c.x},${c.y}`);
    }
    for (const key of ['text', 'graphic', 'activeGraphic', 'option', 'font', 'colour', 'model', 'anim'] as const) {
        const value = com[key];
        if (value !== null && value !== -1 && !(key === 'font' && com.comType !== Component.TYPE_TEXT) && !(key === 'colour' && value === 0)) {
            fields[key] = key === 'colour' ? `0x${(value as number).toString(16)}` : value;
        }
    }
    return fields;
}

async function cli(args: string[]) {
    const [command, name] = args;
    switch (command) {
        case 'interface': {
            const coms = interfaceComponents(name);
            if (coms.length === 0) {
                console.log(`no interface named ${name}`);
                process.exitCode = 1;
                return;
            }
            coms.forEach(com => console.log(JSON.stringify(describe(com))));
            break;
        }
        case 'component': {
            const com = getComponent(name);
            if (!com) {
                console.log(`no component named ${name}`);
                process.exitCode = 1;
                return;
            }
            console.log(JSON.stringify(describe(com), null, 2));
            break;
        }
        case 'sprite': {
            const tiles = readSpriteTiles(name);
            if (tiles.length === 0) {
                console.log(`no sprite named ${name} in the media archive`);
                process.exitCode = 1;
                return;
            }
            tiles.forEach((p, i) => console.log(`${i}\ttile ${p.width}x${p.height}\tcrop ${p.cropLeft},${p.cropTop} ${p.cropRight}x${p.cropBottom}\tfirst colour 0x${firstColour(p).toString(16)}`));
            break;
        }
        default:
            console.log('Usage: bun tools/mod/InspectInterfaces.ts interface <name> | component <iface:com> | sprite <name>');
            if (command) {
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
