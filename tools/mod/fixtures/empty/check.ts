// Checks for the empty fixture: a build with no mods. Run after `core`
// (e.g. `bun run mod:fixture core empty`) it also shows that removing mods
// drops their content.
import path from 'path';

import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import { convertImage } from '#tools/pack/PixPack.js';
import { crc, expect, readCompiledScripts, readJagEntry, readSymbols } from '#tools/mod/Inspect.js';

expect(!readSymbols('npc').has('core_guard'), 'no core_guard in npc.sym');
expect(!readSymbols('runescript').has('[opnpc1,core_guard]'), 'no mod script symbols');
expect(![...readCompiledScripts().values()].some(s => s.source.includes('data/pack/mods/scripts')), 'no compiled script comes from the mod staging dir');
expect(readJagEntry(6, '50.dat') === null, 'textures jag has only the 50 base textures');

const index = Packet.alloc(3);
const logo = await convertImage(index, path.join(Environment.BUILD_SRC_DIR, 'title'), 'logo');
const packed = readJagEntry(1, 'logo.dat');
expect(packed !== null && Buffer.compare(Buffer.from(packed), Buffer.from(logo.data.subarray(0, logo.pos))) === 0, 'title logo.dat is the base logo');

// interfaces and sprites: nothing from mods; the interface archive is exactly base content again
expect(!readSymbols('interface').has('if_journal') && !readSymbols('component').has('questlist:if_quest'), 'no mod interfaces or components in the symbols');
expect(crc(readJagEntry(3, 'data')!) === 587792799, 'interface archive data has the base content CRC');
expect(readJagEntry(4, 'if_scroll.dat') === null, 'no mod sprites in the media archive');
