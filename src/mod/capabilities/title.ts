// Capability: title screen.
//
// Mod layout (mirrors the content dir):
//   title/logo.png, title/runes.png, title/titlebox.png, title/titlebutton.png
//     (optional title/meta/<name>.opt)
//   binary/title.jpg  (background)
// Each file replaces the base one. Later mods in load order win (warning).
// tools/pack/sprite/title.ts reads ModManager.getAsset('title', <name>) and
// ModManager.getAsset('binary', 'title'), so the result lands in cache
// archive 0 file 1 and the normal CRC table covers it.

import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';

export const TITLE_SPRITES = ['logo', 'runes', 'titlebox', 'titlebutton'];

const capability: ModCapability = {
    name: 'title',

    afterRevalidate() {
        for (const file of ModManager.listFiles('title', '.png', { recursive: false })) {
            if (!TITLE_SPRITES.includes(file.name)) {
                ModManager.warn(file, null, `unknown title sprite (expected one of: ${TITLE_SPRITES.join(', ')}); ignored`);
                continue;
            }
            ModManager.claim('title', file.name, file);
            ModManager.setAsset('title', file.name, file.path);
        }

        for (const file of ModManager.listFiles('binary', '.jpg', { recursive: false })) {
            if (file.name !== 'title') {
                continue;
            }
            ModManager.claim('binary', file.name, file);
            ModManager.setAsset('binary', file.name, file.path);
        }
    }
};

export default capability;
