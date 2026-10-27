// A build with no mods, run after the scripts fixture:
//   bun run mod:fixture scripts scripts-removed
// Removing the override and patch mods restores base scripts and configs.
import path from 'path';

import EnumType from '#/cache/config/EnumType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import Environment from '#/util/Environment.js';
import { expect, readCompiledScripts } from '#tools/mod/Inspect.js';

const content = path.resolve(Environment.BUILD_SRC_DIR, 'scripts');

ScriptProvider.load('data/pack');
const scripts = readCompiledScripts();
expect(![...scripts.keys()].some(name => /^\[(label|proc),original\d*_/.test(name)), 'no generated original_ scripts are compiled');
expect(![...scripts.values()].some(s => s.source.includes('data/pack/mods/')), 'no compiled script comes from data/pack/mods');
expect(path.resolve(ScriptProvider.getByName('[opnpc1,hans]')!.info.sourceFilePath) === path.join(content, 'areas/area_lumbridge/scripts/hans.rs2'), '[opnpc1,hans] is the base script again');
expect(path.resolve(ScriptProvider.getByName('[proc,count_questpoints]')!.info.sourceFilePath) === path.join(content, 'general/scripts/quests.rs2'), '[proc,count_questpoints] is the base proc again');
expect(!ScriptProvider.getByName('[opnpc1,man]'), 'no [opnpc1,man]: man talks through [opnpc1,_citizen] again');

ParamType.load('data/pack');
NpcType.load('data/pack');
ObjType.load('data/pack');
EnumType.load('data/pack');
const man = NpcType.getByName('man')!;
expect(man.name === 'Man' && man.op?.[1] === 'Attack', 'npc man is the base config again');
expect(ObjType.getByName('cake')!.name === 'Cake', 'obj cake is the base config again');
expect(EnumType.getByName('quest_names_enum')!.values.has(5), 'enum quest_names_enum has val 5 again');
