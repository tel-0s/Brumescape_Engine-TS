// Capability: custom textures.
//
// Mod layout: textures/**/<name>.png (optional textures/**/meta/<name>.opt).
// A new name gets a stable texture id after the 50 base textures (the
// Brumescape client allows up to 256). A name that exists in base content
// replaces that texture. Later mods in load order win (warning).
//
// The texture packer (tools/pack/sprite/textures.ts) reads each texture from
// ModManager.getAsset('texture', name) and falls back to content/textures.

import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';
import { TexturePack } from '#tools/pack/PackFile.js';

const capability: ModCapability = {
    name: 'textures',

    afterRevalidate() {
        for (const file of ModManager.listFiles('textures', '.png')) {
            if (file.subPath.split('/').includes('meta')) {
                continue;
            }
            ModManager.claim('texture', file.name, file);
            ModManager.registerName('texture', TexturePack, file.name);
            ModManager.setAsset('texture', file.name, file.path);
        }
    }
};

export default capability;
