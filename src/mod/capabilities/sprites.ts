// Capability: 2D sprites in the media archive (cache archive 0 file 4).
//
// Mod layout (mirrors content/sprites):
//   sprites/**/<name>.png
//   sprites/**/meta/<name>.opt       optional: crop box, or tile size and boxes of a sheet
//   sprites/**/meta/<name>.pal.png   optional: fixed palette order (rarely needed)
// The meta folder sits next to the .png it describes.
//
// A new name adds a sprite that interfaces can use (graphic=<name>,<index>).
// A name that exists in content/sprites replaces that sprite (side icons,
// map icons, ...). Later mods in load order win (warning). Sprite names have
// no ids: the client finds them by name in the media archive.
//
// Every mod sprite is staged into data/pack/mods/sprites/ with its meta.
// When a sheet's .opt has only the tile size line, or when a replacement of
// a base sheet has no .opt, the crop box of every tile is generated from the
// image. tools/pack/sprite/media.ts reads ModManager.getAsset('sprite', name).

import fs from 'fs';
import path from 'path';

import { Jimp } from 'jimp';

import { genHash } from '#/io/Jagfile.js';
import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';
import { printInfo } from '#/util/Logger.js';
import { listFilesExt } from '#tools/pack/Parse.js';

export const SPRITE_NAME = /^[a-z0-9_]+$/;

interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

// The packed shape of a sprite: one image, or a sheet of tileW x tileH tiles
export interface SpriteShape {
    tiles: number;
    tileW: number;
    tileH: number;
}

// Sprites in content/sprites: name -> shape (from its meta .opt)
let baseSprites: Map<string, SpriteShape & { opt: string[] | null }> | null = null;
// Sprites mods add or replace in this build: name -> shape
const modSprites: Map<string, SpriteShape & { file: ModFile }> = new Map();

function readOpt(file: string): string[] {
    return fs
        .readFileSync(file, 'ascii')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

function loadBaseSprites() {
    const dir = `${Environment.BUILD_SRC_DIR}/sprites`;
    const out = new Map<string, SpriteShape & { opt: string[] | null }>();
    for (const file of listFilesExt(dir, '.png')) {
        if (path.basename(path.dirname(file)) === 'meta') {
            continue;
        }
        const name = path.basename(file, '.png');
        const optPath = `${dir}/meta/${name}.opt`;
        const opt = fs.existsSync(optPath) ? readOpt(optPath) : null;
        if (opt && opt.length > 0 && opt[0].includes('x')) {
            const [tileW, tileH] = opt[0].split('x').map(v => parseInt(v, 10));
            out.set(name, { tiles: opt.length - 1, tileW, tileH, opt });
        } else {
            out.set(name, { tiles: 1, tileW: 0, tileH: 0, opt });
        }
    }
    baseSprites = out;
}

// Sprites in content/sprites (name -> shape). Loaded once per build.
export function getBaseSprites(): ReadonlyMap<string, SpriteShape> {
    if (!baseSprites) {
        loadBaseSprites();
    }
    return baseSprites!;
}

// The shape of sprite `name` in this build (a mod sprite, else base content),
// or undefined when no sprite has that name.
export function getSpriteShape(name: string): SpriteShape | undefined {
    return modSprites.get(name) ?? getBaseSprites().get(name);
}

// Opaque pixels as convertImage (tools/pack/PixPack.ts) treats them: alpha
// >= 128 and not close to the #FF00FF transparency colour.
function isOpaque(data: Buffer | Uint8Array, pos: number): boolean {
    if (data[pos + 3] < 128) {
        return false;
    }
    const dist = (data[pos] - 255) ** 2 + data[pos + 1] ** 2 + (data[pos + 2] - 255) ** 2;
    return dist >= 10000;
}

// Tight crop box of the opaque pixels of one tile. An empty tile gets a 1x1
// box (every tile must have at least one pixel). The offset is stored in one
// byte, so it is limited to 255.
function trimTile(data: Buffer | Uint8Array, width: number, tx: number, ty: number, tileW: number, tileH: number): Box {
    let left = tileW;
    let top = tileH;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < tileH; y++) {
        for (let x = 0; x < tileW; x++) {
            if (isOpaque(data, ((ty + y) * width + tx + x) * 4)) {
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
            }
        }
    }
    if (right < 0) {
        return { x: 0, y: 0, w: 1, h: 1 };
    }
    const x = Math.min(left, 255);
    const y = Math.min(top, 255);
    return { x, y, w: right + 1 - x, h: bottom + 1 - y };
}

function parseBox(file: ModFile, optRel: string, line: string, limitW: number, limitH: number, what: string): void {
    const parts = line.split(',');
    const nums = parts.slice(0, 4).map(v => (/^\d+$/.test(v.trim()) ? parseInt(v, 10) : NaN));
    if (parts.length < 4 || parts.length > 5 || nums.some(n => isNaN(n)) || (parts.length === 5 && !['row', 'column'].includes(parts[4].trim()))) {
        throw ModManager.error(file, null, `${optRel}: invalid crop box '${line}' for ${what} (expected x,y,width,height with an optional ,row)`);
    }
    const [x, y, w, h] = nums;
    if (w < 1 || h < 1 || x > 255 || y > 255 || x + w > limitW || y + h > limitH) {
        throw ModManager.error(file, null, `${optRel}: crop box '${line}' for ${what} must have width and height >= 1, x and y <= 255, and fit inside ${limitW}x${limitH}`);
    }
}

// Stage one mod sprite into `root` (png, meta/<name>.opt, meta/<name>.pal.png)
// and return its shape. Validates the meta against the image.
async function stageSprite(file: ModFile, root: string): Promise<SpriteShape> {
    const name = file.name;
    const dir = path.dirname(file.path);
    const optPath = path.join(dir, 'meta', `${name}.opt`);
    const palPath = path.join(dir, 'meta', `${name}.pal.png`);
    const optRel = path.relative(file.mod.dir, optPath).split(path.sep).join('/');

    const img = await Jimp.read(file.path);
    const width = img.bitmap.width;
    const height = img.bitmap.height;
    if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
        throw ModManager.error(file, null, `image size ${width}x${height} is out of range (1 to 65535)`);
    }

    let opt: string[] | null = null;
    let tileSize: [number, number] | null = null;
    let generated = false;
    let shape: SpriteShape = { tiles: 1, tileW: width, tileH: height };

    if (fs.existsSync(optPath)) {
        const lines = readOpt(optPath);
        if (lines.length === 0) {
            throw ModManager.error(file, null, `${optRel} is empty`);
        }
        if (lines[0].includes('x')) {
            const match = /^(\d+)x(\d+)$/.exec(lines[0]);
            if (!match) {
                throw ModManager.error(file, null, `${optRel}: first line '${lines[0]}' must be the tile size, e.g. 25x25`);
            }
            tileSize = [parseInt(match[1], 10), parseInt(match[2], 10)];
            if (lines.length > 1) {
                opt = lines;
            }
        } else {
            if (lines.length !== 1) {
                throw ModManager.error(file, null, `${optRel}: a single sprite has one crop box line (x,y,width,height); for a sheet, start with the tile size (e.g. 25x25)`);
            }
            parseBox(file, optRel, lines[0], width, height, 'the image');
            opt = lines;
        }
    } else {
        const base = getBaseSprites().get(name) as (SpriteShape & { opt: string[] | null }) | undefined;
        if (base && base.tiles > 1) {
            // A replacement for a base sheet keeps the sheet's tile size
            tileSize = [base.tileW, base.tileH];
        }
    }

    if (tileSize) {
        const [tileW, tileH] = tileSize;
        if (tileW < 1 || tileH < 1 || width % tileW !== 0 || height % tileH !== 0) {
            const from = fs.existsSync(optPath) ? optRel : `the base sheet ${name} (add ${optRel} to change it)`;
            throw ModManager.error(file, null, `image size ${width}x${height} is not a whole number of ${tileW}x${tileH} tiles (tile size from ${from})`);
        }
        const columns = width / tileW;
        const tiles = columns * (height / tileH);
        if (opt) {
            if (opt.length - 1 !== tiles) {
                throw ModManager.error(
                    file,
                    null,
                    `${optRel}: the image has ${tiles} tiles of ${tileW}x${tileH}, but the file has ${opt.length - 1} crop box lines (one per tile, left to right, top to bottom; or only the tile size line to generate them)`
                );
            }
            for (let i = 1; i < opt.length; i++) {
                parseBox(file, optRel, opt[i], tileW, tileH, `tile ${i - 1}`);
            }
        } else {
            const boxes: string[] = [`${tileW}x${tileH}`];
            for (let t = 0; t < tiles; t++) {
                const box = trimTile(img.bitmap.data, width, (t % columns) * tileW, Math.floor(t / columns) * tileH, tileW, tileH);
                boxes.push(`${box.x},${box.y},${box.w},${box.h}`);
            }
            opt = boxes;
            generated = true;
        }
        shape = { tiles, tileW, tileH };
    }

    fs.copyFileSync(file.path, path.join(root, `${name}.png`));
    if (opt) {
        fs.writeFileSync(path.join(root, 'meta', `${name}.opt`), opt.join('\n') + '\n');
    }
    if (fs.existsSync(palPath)) {
        fs.copyFileSync(palPath, path.join(root, 'meta', `${name}.pal.png`));
    }
    if (generated) {
        printInfo(`[mods] ${file.mod.name}: generated crop boxes for ${shape.tiles} tiles of sprite ${name} (${shape.tileW}x${shape.tileH})`);
    }
    return shape;
}

const capability: ModCapability = {
    name: 'sprites',

    async afterRevalidate() {
        baseSprites = null;
        modSprites.clear();

        // name -> winning file; also rejects the same name twice in one mod
        const winners = new Map<string, ModFile>();
        for (const file of ModManager.listFiles('sprites', '.png')) {
            if (file.subPath.split('/').includes('meta')) {
                continue; // meta/<name>.pal.png
            }
            if (!SPRITE_NAME.test(file.name)) {
                throw ModManager.error(file, null, `invalid sprite name '${file.name}': use lower-case letters, digits and _`);
            }
            const previous = ModManager.claim('sprite', file.name, file);
            if (previous && previous.mod === file.mod) {
                throw ModManager.error(file, null, `sprite ${file.name} is also defined by ${previous.relPath}`);
            }
            winners.set(file.name, file);
        }

        const root = ModManager.stagingDir('sprites');
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
        if (winners.size === 0) {
            return;
        }

        // Jag entries are found by a case-insensitive hash of the file name,
        // so a new name must not hash like an existing one.
        const hashes = new Map<number, string>();
        hashes.set(genHash('index.dat'), 'index.dat');
        for (const name of getBaseSprites().keys()) {
            hashes.set(genHash(`${name}.dat`), name);
        }

        for (const [name, file] of winners) {
            if (getBaseSprites().has(name)) {
                printInfo(`[mods] ${file.mod.name} replaces base sprite ${name}`);
            } else {
                const clash = hashes.get(genHash(`${name}.dat`));
                if (clash !== undefined && clash !== name) {
                    throw ModManager.error(file, null, `sprite name ${name} has the same archive hash as ${clash}; choose another name`);
                }
                hashes.set(genHash(`${name}.dat`), name);
            }

            const shape = await stageSprite(file, root);
            modSprites.set(name, { ...shape, file });
            ModManager.setAsset('sprite', name, path.join(root, `${name}.png`));
        }
    }
};

export default capability;
