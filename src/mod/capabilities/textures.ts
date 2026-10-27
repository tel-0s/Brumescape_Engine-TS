// Capability: custom textures.
//
// Mod layout: textures/**/<name>.png (optional textures/**/meta/<name>.opt).
// A new name gets a stable texture id after the 50 base textures. The
// Brumescape client holds ids 0-255, so a higher id stops the build. A name
// that exists in base content replaces that texture. Later mods in load order
// win (warning); the same name twice in one mod is an error.
//
// The texture packer (tools/pack/sprite/textures.ts) reads each texture from
// ModManager.getAsset('texture', name) and falls back to content/textures.
// It packs a placeholder for an id that idmap.json keeps for a mod that is
// not enabled, so a gap in the ids is safe.

import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';
import { TexturePack } from '#tools/pack/PackFile.js';

// Pix3D in the Brumescape client (was 50 in the 2004 client)
export const MAX_CLIENT_TEXTURES = 256;

const capability: ModCapability = {
    name: 'textures',

    afterRevalidate() {
        for (const file of ModManager.listFiles('textures', '.png')) {
            if (file.subPath.split('/').includes('meta')) {
                continue;
            }
            const previous = ModManager.claim('texture', file.name, file);
            if (previous && previous.mod === file.mod) {
                throw ModManager.error(file, null, `texture ${file.name} is also defined by ${previous.relPath}`);
            }
            const id = ModManager.registerName('texture', TexturePack, file.name);
            if (id >= MAX_CLIENT_TEXTURES) {
                throw ModManager.error(
                    file,
                    null,
                    `texture ${file.name} got id ${id}, but the client holds only ${MAX_CLIENT_TEXTURES} textures (ids 0-${MAX_CLIENT_TEXTURES - 1}). Base content uses ids 0-49, and mods/idmap.json keeps the ids of disabled and removed mods.`
                );
            }
            ModManager.setAsset('texture', file.name, file.path);
        }
    }
};

export default capability;
