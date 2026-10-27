import fs from 'fs';
import path from 'path';

import FileStream from '#/io/FileStream.js';
import Packet from '#/io/Packet.js';
import { convertImage } from '#tools/pack/PixPack.js';
import Environment from '#/util/Environment.js';
import Jagfile from '#/io/Jagfile.js';
import { TexturePack } from '#tools/pack/PackFile.js';
import ModManager from '#/mod/ModManager.js';

// A texture id with no texture in this build: one that mods/idmap.json keeps
// for a mod that is disabled or removed. It gets a plain 64x64 grey texture.
// Nothing in the build uses the id, but the client needs every id up to the
// last one: it counts the textures it loaded (Pix3D.textureCount) and only
// scans that many ids when it reuses texel buffers.
export const PLACEHOLDER_TEXTURE_SIZE = 64;
export const PLACEHOLDER_TEXTURE_RGB = 0x808080;

function packPlaceholderTexture(index: Packet): Packet {
    const size = PLACEHOLDER_TEXTURE_SIZE;
    const data = Packet.alloc(4);
    data.p2(index.pos);

    index.p2(size); // tile width
    index.p2(size); // tile height
    index.p1(2); // palette: index 0 (transparent) and one colour
    index.p3(PLACEHOLDER_TEXTURE_RGB);
    index.p1(0); // crop x
    index.p1(0); // crop y
    index.p2(size); // crop width
    index.p2(size); // crop height
    index.p1(0); // pixel order

    for (let i = 0; i < size * size; i++) {
        data.p1(1);
    }
    return data;
}

export async function packClientTexture(cache: FileStream) {
    const index = Packet.alloc(3);

    // Base textures live in content/textures; a mod texture (new, or replacing
    // a base one) comes from the mod (src/mod/capabilities/textures.ts). Loop to
    // TexturePack.max so injected ones pack.
    const all = [];
    for (let id = 0; id < TexturePack.max; id++) {
        const name = TexturePack.getById(id);
        if (!name) {
            all.push(packPlaceholderTexture(index));
            continue;
        }
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
