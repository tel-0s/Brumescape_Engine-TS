// Checks for the scripts fixture (bun run mod:fixture scripts): script
// overrides and calls to the original, read back from the compiled
// script.dat with the engine's own ScriptProvider, and config patches read
// back with the engine's config decoders.
import fs from 'fs';
import path from 'path';

import CategoryType from '#/cache/config/CategoryType.js';
import NpcType from '#/cache/config/NpcType.js';
import ScriptFile from '#/engine/script/ScriptFile.js';
import { ScriptOpcode } from '#/engine/script/ScriptOpcode.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { scanScriptBlocks, splitSourceLines } from '#/mod/RuneScriptSource.js';
import Environment from '#/util/Environment.js';
import { expect } from '#tools/mod/Inspect.js';

import './check-patches.js';

const fixture = Environment.BUILD_MODS_DIR;
const content = path.resolve(Environment.BUILD_SRC_DIR, 'scripts');
const staged = (mod: string, file: string) => path.resolve('data/pack/mods/scripts', mod, file);
const stagedBase = (file: string) => path.resolve('data/pack/mods/overrides/base', file);

expect(ScriptProvider.load('data/pack') > 0, 'compiled scripts load with ScriptProvider');
NpcType.load('data/pack');
CategoryType.load('data/pack');

function script(name: string): ScriptFile {
    const found = ScriptProvider.getByName(name);
    expect(found, `${name} is compiled`);
    return found;
}

// ids of the scripts that `from` jumps to (@) or calls (~)
function targets(from: ScriptFile, kind: 'jump' | 'call'): number[] {
    const ops = kind === 'jump' ? [ScriptOpcode.JUMP, ScriptOpcode.JUMP_WITH_PARAMS] : [ScriptOpcode.GOSUB, ScriptOpcode.GOSUB_WITH_PARAMS];
    return from.opcodes.flatMap((op, i) => (ops.includes(op) ? [from.intOperands[i]] : []));
}

function expectLink(from: string, kind: 'jump' | 'call', to: string) {
    const target = script(to);
    expect(targets(script(from), kind).includes(target.id), `${from} ${kind === 'jump' ? 'jumps to' : 'calls'} ${to} (id ${target.id})`);
}

function expectSource(name: string, file: string, line?: number) {
    const s = script(name);
    expect(path.resolve(s.info.sourceFilePath) === file, `${name} is compiled from ${file} (got ${s.info.sourceFilePath})`);
    if (line !== undefined) {
        // the first line of the line table is the first statement after the header
        expect(s.info.lines[0] === line, `${name}'s first statement is at line ${line} of ${path.basename(file)} (got ${s.info.lines[0]})`);
    }
}

function sameCode(a: ScriptFile, b: ScriptFile): boolean {
    return JSON.stringify([a.opcodes, a.intOperands, a.stringOperands, a.switchTables, a.info.lines, a.info.pcs]) === JSON.stringify([b.opcodes, b.intOperands, b.stringOperands, b.switchTables, b.info.lines, b.info.pcs]);
}

// The staged copy of a base file differs from the original only in the given header lines
function expectRenamedCopy(rel: string, renames: Record<number, string>) {
    const original = splitSourceLines(fs.readFileSync(path.join(content, rel), 'utf-8'));
    const copy = splitSourceLines(fs.readFileSync(stagedBase(rel), 'utf-8'));
    expect(original.length === copy.length, `staged ${rel} has the same line count as the base file`);
    for (let i = 0; i < original.length; i++) {
        if (renames[i + 1] !== undefined) {
            expect(copy[i].startsWith(renames[i + 1]), `staged ${rel}:${i + 1} is renamed to ${renames[i + 1]} (got ${copy[i]})`);
        } else {
            expect(copy[i] === original[i], `staged ${rel}:${i + 1} is unchanged`);
        }
    }
}

// ---- 1. [opnpc1,man]: a new type-specific script that shadows [opnpc1,_citizen] ----
const man = NpcType.getByName('man')!;
const citizen = CategoryType.getByName('citizen')!;
expect(man.category === citizen.id, 'npc man has category citizen');

// override_chain (later in load order) wins; its original is override_demo's block,
// whose original is a copy of [opnpc1,_citizen]
expectSource('[opnpc1,man]', staged('override_chain', 'chain.rs2'), 5);
expectSource('[label,original_opnpc1_man]', staged('override_demo', 'npcs.rs2'), 6);
expectLink('[opnpc1,man]', 'jump', '[label,original_opnpc1_man]');
expectLink('[label,original_opnpc1_man]', 'jump', '[label,original1_opnpc1_man]');
const shadowCopy = script('[label,original1_opnpc1_man]');
expect(shadowCopy.info.sourceFilePath.endsWith('data/pack/mods/overrides/copies/label_original1_opnpc1_man/man.rs2'), 'the shadow original is a generated copy');
expect(sameCode(shadowCopy, script('[opnpc1,_citizen]')), 'the shadow original has the same bytecode and line table as base [opnpc1,_citizen]');
expectSource('[opnpc1,_citizen]', path.join(content, 'npc/scripts/man.rs2'));

// engine lookup: man gets the mod script, other citizens still get [opnpc1,_citizen]
expect(ScriptProvider.getByTrigger(ServerTriggerType.OPNPC1, man.id, man.category)?.name === '[opnpc1,man]', 'talking to man runs [opnpc1,man]');
const otherCitizen = NpcType.configs.find(n => n && n.category === citizen.id && n.id !== man.id)!;
expect(ScriptProvider.getByTrigger(ServerTriggerType.OPNPC1, otherCitizen.id, otherCitizen.category)?.name === '[opnpc1,_citizen]', `talking to ${otherCitizen.debugname} still runs [opnpc1,_citizen]`);

// ---- 2. [opnpc1,hans]: replaces a base script; chain of two mods ----
expectSource('[opnpc1,hans]', staged('override_chain', 'chain.rs2'), 12);
expectSource('[label,original_opnpc1_hans]', staged('override_demo', 'npcs.rs2'), 15);
expectSource('[label,original1_opnpc1_hans]', stagedBase('areas/area_lumbridge/scripts/hans.rs2'), 3);
expectLink('[opnpc1,hans]', 'jump', '[label,original_opnpc1_hans]');
expectLink('[label,original_opnpc1_hans]', 'jump', '[label,original1_opnpc1_hans]');
expectRenamedCopy('areas/area_lumbridge/scripts/hans.rs2', { 1: '[label,original1_opnpc1_hans]' });
const hans = NpcType.getByName('hans')!;
expect(ScriptProvider.getByTrigger(ServerTriggerType.OPNPC1, hans.id, hans.category)?.name === '[opnpc1,hans]', 'talking to hans runs the override');
// override_demo's file: its block is renamed in place, its reference rewritten to the level below
const demoNpcs = splitSourceLines(fs.readFileSync(staged('override_demo', 'npcs.rs2'), 'utf-8'));
expect(demoNpcs[4] === '[label,original_opnpc1_man]' && demoNpcs[9] === '@original1_opnpc1_man;', 'override_demo [opnpc1,man] is renamed in its staged copy and jumps to original1');
expect(fs.readFileSync(path.join(fixture, 'override_demo/scripts/npcs.rs2'), 'utf-8').includes('[opnpc1,man]\n'), 'the mod source file itself is not modified');

// ---- 3. procs used by base content ----
// [proc,count_questpoints]: base [proc,update_questpoints] calls the winning override
expectSource('[proc,count_questpoints]', staged('override_chain', 'chain.rs2'), 15);
// (unchanged base proc, compiled from the staged copy of its file)
expectSource('[proc,update_questpoints]', stagedBase('general/scripts/quests.rs2'), 51);
expectLink('[proc,update_questpoints]', 'call', '[proc,count_questpoints]');
expectLink('[proc,count_questpoints]', 'call', '[proc,original_proc_count_questpoints]');
expectSource('[proc,original_proc_count_questpoints]', staged('override_demo', 'quests.rs2'), 4);
expectLink('[proc,original_proc_count_questpoints]', 'call', '[proc,original1_proc_count_questpoints]');
expectSource('[proc,original1_proc_count_questpoints]', stagedBase('general/scripts/quests.rs2'), 58);
// [proc,update_questlist]: called by base [proc,initalltabs] (on login)
expectSource('[proc,update_questlist]', staged('override_demo', 'quests.rs2'), 11);
expectLink('[proc,update_questlist]', 'call', '[proc,original_proc_update_questlist]');
expectSource('[proc,original_proc_update_questlist]', stagedBase('general/scripts/quests.rs2'), 227);
expectRenamedCopy('general/scripts/quests.rs2', { 57: '[proc,original1_proc_count_questpoints]()(int)', 226: '[proc,original_proc_update_questlist]' });
expectLink('[proc,initalltabs]', 'call', '[proc,update_questlist]');

// ---- 4. [login,_], [logout,_] (returns a value), proc form of a trigger original ----
expectSource('[login,_]', staged('override_demo', 'session.rs2'), 2);
expectLink('[login,_]', 'jump', '[label,original_login__]');
expect(ScriptProvider.getByTriggerSpecific(ServerTriggerType.LOGIN, -1, -1)?.name === '[login,_]', 'the engine finds the [login,_] override');
expectSource('[logout,_]', staged('override_demo', 'session.rs2'), 7);
expectLink('[logout,_]', 'call', '[proc,original_logout__]');
expect(ScriptProvider.getByTriggerSpecific(ServerTriggerType.LOGOUT, -1, -1)?.name === '[logout,_]', 'the engine finds the [logout,_] override');
expectLink('[opheld1,thkebabinstructs]', 'call', '[proc,original_opheld1_thkebabinstructs]');
expect(!ScriptProvider.getByName('[label,original_opheld1_thkebabinstructs]'), 'only the proc form is generated when the mod uses ~');
// both forms: the label is the renamed base block, the proc a line-preserving copy of it
expectLink('[opnpc3,zaff]', 'call', '[proc,original_opnpc3_zaff]');
expectLink('[opnpc3,zaff]', 'jump', '[label,original_opnpc3_zaff]');
expectSource('[label,original_opnpc3_zaff]', stagedBase('areas/area_varrock/scripts/zaff.rs2'), 12);
expect(script('[proc,original_opnpc3_zaff]').info.sourceFilePath.endsWith('data/pack/mods/overrides/copies/proc_original_opnpc3_zaff/zaff.rs2'), '[proc,original_opnpc3_zaff] is a generated copy');
expect(JSON.stringify(script('[proc,original_opnpc3_zaff]').info.lines) === JSON.stringify(script('[label,original_opnpc3_zaff]').info.lines), 'the proc copy keeps the line numbers of the base block');

// ---- 5. one override per base trigger type (override_triggers) ----
const triggersFile = path.join(fixture, 'override_triggers/scripts/all_triggers.rs2');
const lines = splitSourceLines(fs.readFileSync(triggersFile, 'utf-8'));
const triggerTypes = new Set<string>();
let checked = 0;
for (const block of scanScriptBlocks(lines)) {
    const body = lines.slice(block.line + 1, block.end).join('\n');
    const ref = body.match(/([~@])(original_[^\s;(]+)/)!;
    const form = ref[1] === '@' ? 'label' : 'proc';
    const original = `[${form},${ref[2]}]`;
    expectSource(block.name, staged('override_triggers', 'all_triggers.rs2'), block.line + 2);
    const base = script(original);
    expect(base.info.sourceFilePath.includes('data/pack/mods/overrides/base/'), `${original} is compiled from a staged base file`);
    expectLink(block.name, form === 'label' ? 'jump' : 'call', original);
    // triggers with a named subject are invoked by name and have no lookup key
    if (!['proc', 'label', 'debugproc', 'queue', 'timer', 'softtimer', 'walktrigger'].includes(block.trigger)) {
        expect(script(block.name).info.lookupKey !== -1, `${block.name} has an engine lookup key`);
        expect(base.info.lookupKey === -1, `${original} has no trigger lookup key`);
    }
    triggerTypes.add(block.trigger);
    checked++;
}
console.log(`override_triggers: ${checked} overrides over ${triggerTypes.size} trigger types checked`);
expect(triggerTypes.size >= 75, 'override_triggers covers every trigger type used by base content');

console.log('scripts fixture: all checks passed');
