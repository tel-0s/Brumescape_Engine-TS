import fs from 'fs';
import path from 'path';

import FileStream from '#/io/FileStream.js';
import Packet from '#/io/Packet.js';
import { convertImage } from '#tools/pack/PixPack.js';
import Environment from '#/util/Environment.js';
import Jagfile from '#/io/Jagfile.js';
import { TexturePack } from '#tools/pack/PackFile.js';
import ModManager from '#/mod/ModManager.js';

export async function packClientTexture(cache: FileStream) {
    const index = Packet.alloc(3);

    // Base textures live in content/textures; a mod texture (new, or replacing
    // a base one) comes from the mod (src/mod/capabilities/textures.ts). Loop to
    // TexturePack.max so injected ones pack.
    const all = [];
    for (let id = 0; id < TexturePack.max; id++) {
        const name = TexturePack.getById(id);
        const override = ModManager.getAsset('texture', name);
        const dir = override ? path.dirname(override) : `${Environment.BUILD_SRC_DIR}/textures`;
        all.push(await convertImage(index, dir, name));
    }

    const textures = Jagfile.new();
    textures.write('index.dat', index);
    for (let id = 0; id < all.length; id++) {
        textures.write(`${id}.dat`, all[id]);
    }
    textures.save('data/pack/client/textures');

    cache.write(0, 6, fs.readFileSync('data/pack/client/textures'));
}
