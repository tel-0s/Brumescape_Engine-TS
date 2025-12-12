import fs from 'fs';

import { Jimp } from 'jimp';
import type { Bitmap } from 'jimp';

import Packet from '#/io/Packet.js';

export function generatePixelOrder(img: { bitmap: Bitmap }) {
    let rowMajorScore = 0;
    let columnMajorScore = 0;

    // calculate row-major score
    let prev = 0;
    for (let j = 0; j < img.bitmap.width * img.bitmap.height; j += 4) {
        const pos = j * 4;
        const current = (img.bitmap.data[pos + 0] << 16) | (img.bitmap.data[pos + 1] << 8) | img.bitmap.data[pos + 2];
        rowMajorScore += current - prev;
        prev = current;
    }

    // calculate column-major score
    prev = 0;
    for (let x = 0; x < img.bitmap.width; x++) {
        for (let y = 0; y < img.bitmap.height; y++) {
            const pos = (x + y * img.bitmap.width) * 4;
            const current = (img.bitmap.data[pos + 0] << 16) | (img.bitmap.data[pos + 1] << 8) | img.bitmap.data[pos + 2];
            columnMajorScore += current - prev;
            prev = current;
        }
    }

    return columnMajorScore < rowMajorScore ? 0 : 1;
}

function getClosestColorIndex(rgb: number, colors: number[]): number {
    let minDist = Number.MAX_VALUE;
    let closest = 0;

    const r1 = (rgb >> 16) & 0xff;
    const g1 = (rgb >> 8) & 0xff;
    const b1 = rgb & 0xff;

    // Start from 1 because 0 is transparent/reserved
    for (let i = 1; i < colors.length; i++) {
        const c2 = colors[i];
        const r2 = (c2 >> 16) & 0xff;
        const g2 = (c2 >> 8) & 0xff;
        const b2 = c2 & 0xff;

        const dist = (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
        if (dist < minDist) {
            minDist = dist;
            closest = i;
        }
    }

    return closest;
}

export function writeImage(img: { bitmap: Bitmap }, data: Packet, index: Packet, colors: number[], meta: Sprite | null = null) {
    let left = 0;
    let top = 0;
    let right = img.bitmap.width;
    let bottom = img.bitmap.height;

    if (meta && meta.w && meta.h) {
        left = meta.x;
        top = meta.y;
        right = meta.w;
        bottom = meta.h;
    }

    index.p1(left); // crop x offset
    index.p1(top); // crop y offset
    index.p2(right); // actual width
    index.p2(bottom); // actual height

    let pixelOrder = generatePixelOrder(img);
    if (meta) {
        pixelOrder = meta.pixelOrder;
    }
    index.p1(pixelOrder);

    if (pixelOrder === 0) {
        for (let j = 0; j < img.bitmap.width * img.bitmap.height; j++) {
            const x = j % img.bitmap.width;
            const y = Math.floor(j / img.bitmap.width);
            if (x >= right || y >= bottom) {
                continue;
            }

            const pos = j * 4 + left * 4 + top * img.bitmap.width * 4;

            let index = 0;
            const alpha = img.bitmap.data[pos + 3];
            
            if (alpha >= 128) {
                const red = img.bitmap.data[pos + 0];
                const green = img.bitmap.data[pos + 1];
                const blue = img.bitmap.data[pos + 2];
                const rgb = ((red << 16) | (green << 8) | blue) >>> 0;

                index = colors.indexOf(rgb);
                if (index === -1) {
                    index = getClosestColorIndex(rgb, colors);
                }
            }

            data.p1(index);
        }
    } else if (pixelOrder === 1) {
        for (let x = 0; x < img.bitmap.width; x++) {
            for (let y = 0; y < img.bitmap.height; y++) {
                if (x >= right || y >= bottom) {
                    continue;
                }

                const pos = (x + y * img.bitmap.width) * 4 + left * 4 + top * img.bitmap.width * 4;

                let index = 0;
                const alpha = img.bitmap.data[pos + 3];

                if (alpha >= 128) {
                    const red = img.bitmap.data[pos + 0];
                    const green = img.bitmap.data[pos + 1];
                    const blue = img.bitmap.data[pos + 2];
                    const rgb = ((red << 16) | (green << 8) | blue) >>> 0;

                    index = colors.indexOf(rgb);
                    if (index === -1) {
                        index = getClosestColorIndex(rgb, colors);
                    }
                }

                data.p1(index);
            }
        }
    }
}

type Sprite = {
    x: number;
    y: number;
    w: number;
    h: number;
    pixelOrder: 0 | 1;
};

function generatePalette(img: { bitmap: Bitmap }) {
    const colors = [0xff00ff];

    for (let j = 0; j < img.bitmap.width * img.bitmap.height; j++) {
        const pos = j * 4;

        const alpha = img.bitmap.data[pos + 3];
        if (alpha < 128) {
            continue; // Transparent, maps to index 0 (0xff00ff) effectively
        }

        const red = img.bitmap.data[pos + 0];
        const green = img.bitmap.data[pos + 1];
        const blue = img.bitmap.data[pos + 2];
        const rgb = ((red << 16) | (green << 8) | blue) >>> 0;
        if (rgb === 0xff00ff) {
            continue;
        }

        if (colors.indexOf(rgb) === -1) {
            colors.push(rgb);
        }
    }

    return colors;
}

export async function convertImage(index: Packet, srcPath: string, safeName: string) {
    const data = Packet.alloc(4);
    data.p2(index.pos);

    const img = await Jimp.read(`${srcPath}/${safeName}.png`);

    // Handle magic pink transparency (#FF00FF)
    // Scan the image and convert near-#FF00FF pixels to transparent black
    // This removes anti-aliasing artifacts against the pink background
    for (let j = 0; j < img.bitmap.width * img.bitmap.height; j++) {
        const pos = j * 4;
        const r = img.bitmap.data[pos + 0];
        const g = img.bitmap.data[pos + 1];
        const b = img.bitmap.data[pos + 2];
        
        // Euclidean distance squared from (255, 0, 255)
        const dist = (r - 255) ** 2 + (g - 0) ** 2 + (b - 255) ** 2;

        // Increased threshold to be more aggressive against pink fringing
        // 10000 covers a wider range of magenta-ish pixels
        if (dist < 10000) {
            img.bitmap.data[pos + 3] = 0; // Set Alpha to 0
            img.bitmap.data[pos + 0] = 0;
            img.bitmap.data[pos + 1] = 0;
            img.bitmap.data[pos + 2] = 0;
        }
    }

    let tileX = img.bitmap.width;
    let tileY = img.bitmap.height;

    const sprites: Sprite[] = [];
    const hasMeta = fs.existsSync(`${srcPath}/meta/${safeName}.opt`);
    if (hasMeta) {
        const metadata = fs
            .readFileSync(`${srcPath}/meta/${safeName}.opt`, 'ascii')
            .replace(/\r/g, '')
            .split('\n')
            .filter(x => x.length);

        if (metadata[0].indexOf('x') === -1) {
            const sprite = metadata[0].split(',');

            sprites.push({
                x: parseInt(sprite[0]),
                y: parseInt(sprite[1]),
                w: parseInt(sprite[2]),
                h: parseInt(sprite[3]),
                pixelOrder: sprite[4] === 'row' ? 1 : 0
            });
        } else {
            const tiling = metadata[0].split('x');
            tileX = parseInt(tiling[0]);
            tileY = parseInt(tiling[1]);

            for (let j = 1; j < metadata.length; j++) {
                const sprite = metadata[j].split(',');

                sprites.push({
                    x: parseInt(sprite[0]),
                    y: parseInt(sprite[1]),
                    w: parseInt(sprite[2]),
                    h: parseInt(sprite[3]),
                    pixelOrder: sprite[4] === 'row' ? 1 : 0
                });
            }
        }
    }

    index.p2(tileX);
    index.p2(tileY);

    let colors: number[] = [];
    if (fs.existsSync(`${srcPath}/meta/${safeName}.pal.png`)) {
        // workaround to preserve CRC integrity (not required)
        colors = generatePalette(await Jimp.read(`${srcPath}/meta/${safeName}.pal.png`));
    } else {
        // todo: we're not producing the color palette in the same way, so this breaks CRC checks.
        //   however, the end result after decoding is the same
        colors = generatePalette(img);
    }

    if (colors.length > 255) {
        // console.log(`[PixPack] Quantizing image (colors: ${colors.length} -> 255)`);
        // Reserve index 0 for transparency, so we can only have 254 visible colors max to fit in a byte (255 total)
        img.quantize({ colors: 254 });
        colors = generatePalette(img);
        // console.log(`[PixPack] Post-quantization colors: ${colors.length}`);
    }

    if (colors.length > 255) {
        console.warn(`[PixPack] Warning: Palette size ${colors.length} exceeds byte limit (255). Truncating palette.`);
        colors.length = 255;
    }

    index.p1(colors.length);
    for (let j = 1; j < colors.length; j++) {
        index.p3(colors[j]);
    }

    if (sprites.length > 1) {
        for (let y = 0; y < img.bitmap.height / tileY; y++) {
            for (let x = 0; x < img.bitmap.width / tileX; x++) {
                const tile = img.clone().crop({
                    x: x * tileX,
                    y: y * tileY,
                    w: tileX,
                    h: tileY
                });
                writeImage(tile, data, index, colors, sprites[x + y * (img.bitmap.width / tileX)]);
            }
        }
    } else {
        writeImage(img, data, index, colors, sprites[0]);
    }

    return data;
}
