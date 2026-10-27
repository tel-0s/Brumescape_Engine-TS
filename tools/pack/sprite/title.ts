import fs from 'fs';
import path from 'path';

import FileStream from '#/io/FileStream.js';
import { convertImage } from '#tools/pack/PixPack.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import Jagfile from '#/io/Jagfile.js';
import ModManager from '#/mod/ModManager.js';

// Directory holding <name>.png: a mod's override (see src/mod/capabilities/title.ts) or base content
function titleSpriteDir(name: string): string {
    const override = ModManager.getAsset('title', name);
    return override ? path.dirname(override) : `${Environment.BUILD_SRC_DIR}/title`;
}

export async function packClientTitle(cache: FileStream) {
    const index = Packet.alloc(3);
    const logo = await convertImage(index, titleSpriteDir('logo'), 'logo');
    const runes = await convertImage(index, titleSpriteDir('runes'), 'runes');
    const titlebox = await convertImage(index, titleSpriteDir('titlebox'), 'titlebox');
    const titlebutton = await convertImage(index, titleSpriteDir('titlebutton'), 'titlebutton');

    const b12 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'b12');
    const p11 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'p11');
    const p12 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'p12');
    const q8 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'q8');

    const title = Jagfile.new();
    title.write('title.dat', Packet.load(ModManager.getAsset('binary', 'title') ?? `${Environment.BUILD_SRC_DIR}/binary/title.jpg`, true));
    title.write('index.dat', index);
    title.write('logo.dat', logo);
    title.write('runes.dat', runes);
    title.write('titlebox.dat', titlebox);
    title.write('titlebutton.dat', titlebutton);
    title.write('b12.dat', b12);
    title.write('p11.dat', p11);
    title.write('p12.dat', p12);
    title.write('q8.dat', q8);
    title.save('data/pack/client/title');

    cache.write(0, 1, fs.readFileSync('data/pack/client/title'));
}
