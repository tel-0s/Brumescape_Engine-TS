// Checks for the textures-gap fixture: gap_low is disabled, but idmap.json
// keeps its texture id 50; gap_high's texture has id 51. The build must pack a
// placeholder for id 50 (it used to fail on '../content/textures/.png').
import path from 'path';

import Pix from '#/cache/graphics/Pix.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import { expect, readCache, readIdMap } from '#tools/mod/Inspect.js';
import { diffPackedImage } from '#tools/mod/InspectInterfaces.js';
import { PLACEHOLDER_TEXTURE_RGB, PLACEHOLDER_TEXTURE_SIZE } from '#tools/pack/sprite/textures.js';

const fixture = Environment.BUILD_MODS_DIR;
const ids = readIdMap(fixture);
expect(ids.texture?.gap_low_tex === 50 && ids.texture?.gap_high_tex === 51, 'idmap.json keeps id 50 for the disabled mod and 51 for gap_high_tex');

const textures = new Jagfile(new Packet(readCache(0, 6)!));

const placeholder = Pix.unpackJag(textures, '50');
expect(placeholder !== null, 'texture 50 (no enabled mod has it) is packed');
expect(
    placeholder.width === PLACEHOLDER_TEXTURE_SIZE && placeholder.cropRight === PLACEHOLDER_TEXTURE_SIZE && placeholder.pixels.every(p => p === 1) && placeholder.palette[1] === PLACEHOLDER_TEXTURE_RGB,
    'texture 50 is the plain grey placeholder'
);

const high = await diffPackedImage(textures, '51', path.join(fixture, 'gap_high', 'textures'), 'gap_high_tex');
expect(high.pixels > 0 && high.mismatched === 0, 'texture 51 is gap_high_tex');
expect(Pix.unpackJag(textures, '52') === null, 'no texture 52');
