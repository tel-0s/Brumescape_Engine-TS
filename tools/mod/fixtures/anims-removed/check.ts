// Checks for anims-removed: a build with no mods. Run after `anims`
// (bun run mod:fixture anims anims-removed) it shows that removing mods drops
// their animations and models and restores the base animsets they changed.
import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { cacheCount, expect, readCacheGunzip, sameBytes } from '#tools/mod/Inspect.js';

expect(cacheCount(2) === 264, `cache archive 2 has only the 264 base animsets (count ${cacheCount(2)})`);
const changed: string[] = [];
for (let id = 0; id < 264; id++) {
    const content = path.join(Environment.BUILD_SRC_DIR, 'models', `anim_${id}.anim`);
    if (fs.existsSync(content) && !sameBytes(readCacheGunzip(2, id), new Uint8Array(fs.readFileSync(content)))) {
        changed.push(`anim_${id}`);
    }
}
expect(changed.length === 0, `every base animset in the cache is the content file (changed: ${changed.join(', ') || 'none'})`);
const staged = ['anims', 'models'].flatMap(sub => {
    const dir = path.join('data/pack/mods', sub);
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
});
expect(staged.length === 0, `no staged mod animsets or OBJ models (${staged.join(', ') || 'none'})`);
