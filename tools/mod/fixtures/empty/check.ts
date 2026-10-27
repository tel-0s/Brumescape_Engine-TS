// Checks for the empty fixture: a build with no mods. Run after `core`
// (e.g. `bun run mod:fixture core empty`) it also shows that removing mods
// drops their content.
import fs from 'fs';
import path from 'path';

import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import { convertImage } from '#tools/pack/PixPack.js';
import { crc, expect, readBasePack, readCache, readCompiledScripts, readJagEntry, readSymbols } from '#tools/mod/Inspect.js';
import { diffPackedImage } from '#tools/mod/InspectInterfaces.js';

expect(!readSymbols('npc').has('core_guard'), 'no core_guard in npc.sym');
expect(!readSymbols('runescript').has('[opnpc1,core_guard]'), 'no mod script symbols');
expect(![...readCompiledScripts().values()].some(s => s.source.includes('data/pack/mods/scripts')), 'no compiled script comes from the mod staging dir');
expect(readJagEntry(6, '50.dat') === null, 'textures jag has only the 50 base textures');

const index = Packet.alloc(3);
const logo = await convertImage(index, path.join(Environment.BUILD_SRC_DIR, 'title'), 'logo');
const packed = readJagEntry(1, 'logo.dat');
expect(packed !== null && Buffer.compare(Buffer.from(packed), Buffer.from(logo.data.subarray(0, logo.pos))) === 0, 'title logo.dat is the base logo');

// interfaces and sprites: nothing from mods; the interface archive is exactly base content again
expect(!readSymbols('interface').has('if_journal') && !readSymbols('component').has('questlist:if_quest'), 'no mod interfaces or components in the symbols');
expect(crc(readJagEntry(3, 'data')!) === 587792799, 'interface archive data has the base content CRC');
expect(readJagEntry(4, 'if_scroll.dat') === null, 'no mod sprites in the media archive');

// Every base image packs without loss: a pixel is transparent only when its
// alpha is below 128 or it is exactly #FF00FF. (A packer that keyed out
// colours near #FF00FF made the purple of prayeron and magicon transparent.)
const content = Environment.BUILD_SRC_DIR;
const images: { archive: number; entry: string; dir: string; name: string }[] = [];
for (const name of ['logo', 'runes', 'titlebox', 'titlebutton']) {
    images.push({ archive: 1, entry: name, dir: path.join(content, 'title'), name });
}
for (const name of ['b12', 'p11', 'p12', 'q8']) {
    images.push({ archive: 1, entry: name, dir: path.join(content, 'fonts'), name });
}
for (const file of fs.readdirSync(path.join(content, 'sprites')).filter(f => f.endsWith('.png'))) {
    const name = path.basename(file, '.png');
    images.push({ archive: 4, entry: name, dir: path.join(content, 'sprites'), name });
}
for (const [name, id] of readBasePack('texture')) {
    images.push({ archive: 6, entry: String(id), dir: path.join(content, 'textures'), name });
}

const jags = new Map<number, Jagfile>();
let checked = 0;
const problems: string[] = [];
for (const image of images) {
    let jag = jags.get(image.archive);
    if (!jag) {
        jag = new Jagfile(new Packet(readCache(0, image.archive)!));
        jags.set(image.archive, jag);
    }
    const diff = await diffPackedImage(jag, image.entry, image.dir, image.name);
    if (diff.colours > 254) {
        // quantized on purpose: too many colours for one palette
        continue;
    }
    if (diff.pixels === 0) {
        problems.push(`${image.name}: not in the cache`);
    } else if (diff.mismatched > 0) {
        problems.push(`${image.name}: ${diff.mismatched} of ${diff.pixels} pixels differ (${diff.first})`);
    }
    checked++;
}
expect(problems.length === 0, `${checked} base images (title, fonts, sprites, textures) decode to their PNG pixels${problems.length ? `:\n  ${problems.join('\n  ')}` : ''}`);
