import fs from 'fs';
import path from 'path';

import FileStream from '#/io/FileStream.js';
import { convertImage } from '#tools/pack/PixPack.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import Jagfile from '#/io/Jagfile.js';
import { printWarning } from '#/util/Logger.js';
import ModManager from '#/mod/ModManager.js';

// A mod may replace the title logo (title/logo.png, optional title/meta/logo.opt)
// and the background (binary/title.jpg). The last mod in load order wins.
function findModTitleAsset(rel: string): string | null {
    let found: string | null = null;
    let owner: string | null = null;
    for (const mod of ModManager.mods) {
        const file = path.join(mod.path, rel);
        if (!fs.existsSync(file)) {
            continue;
        }
        if (owner !== null) {
            printWarning(`[mods] ${rel} from ${owner} is overridden by ${mod.config.name}`);
        }
        found = file;
        owner = mod.config.name;
    }
    return found;
}

export async function packClientTitle(cache: FileStream) {
    const modLogo = findModTitleAsset('title/logo.png');
    const modBackground = findModTitleAsset('binary/title.jpg');

    const index = Packet.alloc(3);
    const logo = await convertImage(index, modLogo ? path.dirname(modLogo) : `${Environment.BUILD_SRC_DIR}/title`, 'logo');
    const runes = await convertImage(index, `${Environment.BUILD_SRC_DIR}/title`, 'runes');
    const titlebox = await convertImage(index, `${Environment.BUILD_SRC_DIR}/title`, 'titlebox');
    const titlebutton = await convertImage(index, `${Environment.BUILD_SRC_DIR}/title`, 'titlebutton');

    const b12 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'b12');
    const p11 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'p11');
    const p12 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'p12');
    const q8 = await convertImage(index, `${Environment.BUILD_SRC_DIR}/fonts`, 'q8');

    const title = Jagfile.new();
    title.write('title.dat', Packet.load(modBackground ?? `${Environment.BUILD_SRC_DIR}/binary/title.jpg`, true));
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
