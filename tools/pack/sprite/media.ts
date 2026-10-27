import fs from 'fs';
import path from 'path';

import FileStream from '#/io/FileStream.js';
import { listFilesExt } from '#tools/pack/Parse.js';
import Environment from '#/util/Environment.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { convertImage } from '#tools/pack/PixPack.js';
import { fileExists } from '#tools/pack/FsCache.js';
import ModManager from '#/mod/ModManager.js';

export async function packClientMedia(cache: FileStream) {
    const index = Packet.alloc(3);

    // Each sprite is read from its directory (with meta/<name>.opt next to
    // it): content/sprites, or the staged copy of a mod sprite that replaces
    // or adds a name (src/mod/capabilities/sprites.ts).
    const baseDir = `${Environment.BUILD_SRC_DIR}/sprites`;
    const sprites = listFilesExt(baseDir, '.png').map(file => {
        const name = path.basename(file, path.extname(file));
        const override = ModManager.getAsset('sprite', name);
        return { name, dir: override ? path.dirname(override) : baseDir };
    });
    const baseNames = new Set(sprites.map(sprite => sprite.name));
    for (const [name, file] of ModManager.getAssets('sprite')) {
        if (!baseNames.has(name)) {
            sprites.push({ name, dir: path.dirname(file) });
        }
    }

    // organize spritesheets to be last (to help with over-reads)
    sprites.sort((a, b) => {
        const aExists = fileExists(`${a.dir}/meta/${a.name}.opt`);
        const bExists = fileExists(`${b.dir}/meta/${b.name}.opt`);
        return aExists === bExists ? 0 : (aExists && !bExists ? 1 : -1);
    });

    const all = new Map();
    for (const { name, dir } of sprites) {
        // each <name>.dat starts with a 2-byte offset into index.dat
        if (index.pos > 0xffff) {
            throw new Error(`media index.dat is larger than 65535 bytes before sprite ${name}: too many sprites or palette colours (mods add ${ModManager.getAssets('sprite').size})`);
        }
        all.set(name, await convertImage(index, dir, name));
    }

    const media = Jagfile.new();
    media.write('index.dat', index);
    for (const [name, sprite] of all) {
        media.write(`${name}.dat`, sprite);
    }
    media.save('data/pack/client/media');

    cache.write(0, 4, fs.readFileSync('data/pack/client/media'));
}
