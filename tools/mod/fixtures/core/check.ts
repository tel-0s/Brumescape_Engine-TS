// Checks for the core fixture (run by `bun run mod:fixture core` after the build)
import fs from 'fs';
import path from 'path';

import Packet from '#/io/Packet.js';
import { discoverMods } from '#/mod/ModDiscovery.js';
import Environment from '#/util/Environment.js';
import { convertImage } from '#tools/pack/PixPack.js';
import { expect, getConfig, readBasePack, readCacheGunzip, readCompiledScripts, readIdMap, readJagEntry, readSymbols, sameBytes } from '#tools/mod/Inspect.js';

const fixture = Environment.BUILD_MODS_DIR;
const ids = readIdMap(fixture);

// load order: core_addon sorts first but depends on core_base
const order = discoverMods(fixture).mods.map(m => m.name);
expect(order.join(',') === 'core_base,core_addon', `load order is core_base, core_addon (got ${order.join(', ')})`);

// configs: new, overridden by a later mod, replacing base, disabled mod absent
const guard = await getConfig('npc', 'core_guard');
expect(guard?.name === 'Core Guard (addon)', 'npc core_guard is the later mod\'s definition');
expect(guard && (guard as { id: number }).id === ids.npc?.core_guard, 'npc core_guard has its idmap id');
expect((await getConfig('npc', 'hans'))?.name === 'Hans (core)', 'base npc hans is replaced by the mod');
expect(!readSymbols('npc').has('core_disabled_npc'), 'disabled mod contributes nothing (npc.sym)');
expect(readSymbols('varp').has('core_progress'), 'varp core_progress is in varp.sym');

// models: new model packed, base model replaced (cache archive 1)
const box = await getConfig('obj', 'core_box');
expect(box?.model === ids.model?.core_box, 'obj core_box points at the mod model id');
const modModel = fs.readFileSync(path.join(fixture, 'core_base/models/core_box.ob2'));
expect(sameBytes(readCacheGunzip(1, ids.model.core_box), modModel), 'mod model core_box is in cache archive 1');
const baseId = readBasePack('model').get('model_2429_obj')!;
expect(sameBytes(readCacheGunzip(1, baseId), fs.readFileSync(path.join(fixture, 'core_base/models/override/model_2429_obj.ob2'))), 'mod model_2429_obj replaced the base model in the cache');

// textures: new texture after the 50 base ones
expect(ids.texture?.core_tex === 50, 'texture core_tex got id 50');
expect(readJagEntry(6, '50.dat') !== null, 'textures jag has 50.dat');

// title: the later mod's logo is packed into cache archive 0 file 1
const index = Packet.alloc(3);
const logo = await convertImage(index, path.join(fixture, 'core_addon/title'), 'logo');
expect(sameBytes(readJagEntry(1, 'logo.dat'), logo.data.subarray(0, logo.pos)), 'title logo.dat is core_addon\'s logo');

// scripts: same relative filename in two mods, both staged and compiled
const scripts = readCompiledScripts();
expect(scripts.get('[opnpc1,core_guard]')?.source.includes('data/pack/mods/scripts/core_base/quest/start.rs2'), '[opnpc1,core_guard] compiled from core_base/quest/start.rs2');
expect(scripts.get('[opnpc2,core_guard]')?.source.includes('data/pack/mods/scripts/core_addon/quest/start.rs2'), '[opnpc2,core_guard] compiled from core_addon/quest/start.rs2');
expect(scripts.has('[proc,core_init]'), '[proc,core_init] compiled');
expect(readSymbols('runescript').get('[opnpc1,core_guard]') === ids.script?.['[opnpc1,core_guard]'], 'script ids come from the idmap');

// nothing leaked into the content dir
const fixtureNames = new Set(['core_guard', 'core_box', 'core_progress', 'core_tex', 'core_disabled_npc', '[opnpc1,core_guard]', '[opnpc2,core_guard]', '[opheld1,core_box]', '[proc,core_init]']);
const leaked = fs
    .readdirSync(path.join(Environment.BUILD_SRC_DIR, 'pack'))
    .filter(f => f.endsWith('.pack'))
    .filter(f =>
        fs
            .readFileSync(path.join(Environment.BUILD_SRC_DIR, 'pack', f), 'utf-8')
            .split('\n')
            .some(line => fixtureNames.has(line.substring(line.indexOf('=') + 1)))
    );
expect(leaked.length === 0, `no fixture names in ${Environment.BUILD_SRC_DIR}/pack (${leaked.join(', ') || 'none'})`);
expect(!fs.existsSync(path.join(Environment.BUILD_SRC_DIR, 'scripts', '_mods')), 'no content/scripts/_mods');
