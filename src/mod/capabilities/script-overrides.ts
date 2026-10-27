// Capability: script overrides (slot A).
//
// A mod script whose [trigger,subject] matches a base script, or a script of
// an earlier mod, replaces it. The replaced block is not compiled under its
// own name any more:
//
//   - a base block: the base file is staged (data/pack/mods/overrides/base/...)
//     with the block's header renamed, and the original file is omitted from
//     compilation (CompilerConfig.omit);
//   - an earlier mod's block: its header is renamed in that mod's staged copy.
//
// The renamed block is the "original". The overriding mod reaches it as
//   @original_<trigger>_<subject>(...)   a label (jump; does not return), or
//   ~original_<trigger>_<subject>(...)   a proc (call; returns)
// e.g. [opnpc1,hans] -> @original_opnpc1_hans, [proc,foo] -> ~original_proc_foo,
// [login,_] -> @original_login__, [opnpc1,_citizen] -> @original_opnpc1__citizen.
//
//   - The original of a script that returns values ([proc,...], [logout,_]) is
//     always a proc.
//   - Every other original is a label by default (a renamed trigger body may
//     jump to labels, which a proc cannot). If the overriding mod calls it with
//     ~, a proc is generated instead, which only works when the block does not
//     jump to labels. With both @ and ~, both are generated.
//
// Chains: when several mods override the same script, the last one in load
// order wins. Each mod's original is the version it replaced, so
// original_<...> in mod B reaches mod A's override, and A's original reaches
// base content. Internally, deeper levels are renamed original1_..., original2_...
// and the references in the superseded mods' staged files are rewritten.
//
// Shadowing: a new type-specific script such as [opnpc1,man] does not replace
// anything, but it hides the category script ([opnpc1,_citizen]) or the default
// script ([opnpc1,_]) that would otherwise run for that subject. If the mod
// references original_opnpc1_man, that script's block is copied (line numbers
// kept) as the original. Supported for triggers whose engine lookup goes from
// the type to its category to the default; see SHADOW_SUBJECTS.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { findLabelJumps, findPrefixedReferences, findReferences, formatSignature, parseSignature, renameHeader, replaceReferences, sameSignature, scanScriptBlocks, splitSourceLines } from '#/mod/RuneScriptSource.js';
import type { ScriptBlock } from '#/mod/RuneScriptSource.js';
import { stagedScripts } from '#/mod/capabilities/scripts.js';
import Environment from '#/util/Environment.js';
import { printInfo } from '#/util/Logger.js';
import { CategoryPack, ScriptPack } from '#tools/pack/PackFile.js';
import { listFilesExt } from '#tools/pack/Parse.js';

type Form = 'label' | 'proc';
type SubjectConfig = 'npc' | 'obj' | 'loc';

// Triggers whose engine lookup is ScriptProvider.getByTrigger(trigger, type.id,
// type.category): the type-specific script, else [trigger,_<category>], else
// [trigger,_]. Value: the config type of the subject. Not included: opheldu
// (looks at both objs), the *T triggers (component subjects), player triggers
// (no subject config) and triggers without categories.
const SHADOW_SUBJECTS: Record<string, SubjectConfig> = {};
for (let op = 1; op <= 5; op++) {
    for (const [prefix, subject] of [
        ['npc', 'npc'],
        ['obj', 'obj'],
        ['loc', 'loc']
    ] as const) {
        SHADOW_SUBJECTS[`ap${prefix}${op}`] = subject;
        SHADOW_SUBJECTS[`op${prefix}${op}`] = subject;
        SHADOW_SUBJECTS[`ai_ap${prefix}${op}`] = 'npc';
        SHADOW_SUBJECTS[`ai_op${prefix}${op}`] = 'npc';
    }
    SHADOW_SUBJECTS[`ai_applayer${op}`] = 'npc';
    SHADOW_SUBJECTS[`ai_opplayer${op}`] = 'npc';
    SHADOW_SUBJECTS[`opheld${op}`] = 'obj';
}
for (const [prefix, subject] of [
    ['npc', 'npc'],
    ['obj', 'obj'],
    ['loc', 'loc']
] as const) {
    SHADOW_SUBJECTS[`ap${prefix}u`] = subject;
    SHADOW_SUBJECTS[`op${prefix}u`] = subject;
}
for (let queue = 1; queue <= 20; queue++) {
    SHADOW_SUBJECTS[`ai_queue${queue}`] = 'npc';
}
SHADOW_SUBJECTS['ai_timer'] = 'npc';
SHADOW_SUBJECTS['ai_spawn'] = 'npc';
SHADOW_SUBJECTS['ai_despawn'] = 'npc';

// One definition of a [trigger,subject] in a chain
interface Def {
    kind: 'base' | 'mod' | 'shadow';
    // Absolute path of the file holding the block: the base content file, or
    // the staged copy of a mod file. Unset for an unresolved shadow.
    file: string;
    block: ScriptBlock;
    // mod definitions: the mod source file (for messages)
    modFile?: ModFile;
    // shadow definitions: the script it was copied from ([trigger,_category] or [trigger,_])
    shadowOf?: string;
}

// A reference to original_<...> in a mod's scripts
interface Ref {
    file: ModFile;
    staged: string;
    // 0-based
    index: number;
    sigil: '~' | '@';
}

interface Chain {
    key: string;
    trigger: string;
    subject: string;
    // bottom (base, earlier mod or shadow) ... winner. A shadow entry has no
    // block until beforeCompile resolves it.
    entries: (Def | null)[];
    // refs[i]: the references of entries[i] (a mod) to the original it replaced
    refs: Ref[][];
    // forms[i] for every superseded entry (i < last)
    forms: Form[][];
}

let chains: Chain[] = [];
// New type-specific mod scripts that may hide a category or default script
// without calling it (only logged)
let shadowing: { key: string; trigger: string; subject: string; mod: string }[] = [];
let baseIndexCache: Map<string, { file: string; block: ScriptBlock }> | null = null;

function contentScripts(): string {
    return path.resolve(Environment.BUILD_SRC_DIR, 'scripts');
}

// [trigger,subject] -> where base content defines it (engine.rs2 excluded,
// like crawlConfigNames). Built on demand.
function baseIndex(): Map<string, { file: string; block: ScriptBlock }> {
    if (baseIndexCache) {
        return baseIndexCache;
    }
    const index = new Map<string, { file: string; block: ScriptBlock }>();
    const engine = path.join(contentScripts(), 'engine.rs2');
    for (const file of listFilesExt(contentScripts(), '.rs2')) {
        const abs = path.resolve(file);
        if (abs === engine) {
            continue;
        }
        for (const block of scanScriptBlocks(splitSourceLines(fs.readFileSync(abs, 'utf-8')))) {
            if (!index.has(block.name)) {
                index.set(block.name, { file: abs, block });
            }
        }
    }
    baseIndexCache = index;
    return index;
}

// The name the original at `depth` levels below the winner gets: depth 0 is the
// script the winner replaced (the name mods write), deeper levels are internal.
function originalName(trigger: string, subject: string, depth: number): string {
    return `original${depth === 0 ? '' : depth}_${trigger}_${subject}`;
}

function scriptName(form: Form, name: string): string {
    return `[${form},${name}]`;
}

function isReturning(def: Def): boolean {
    return def.block.trigger === 'proc' || parseSignature(def.block.rest).returns.length > 0;
}

function describe(def: Def): string {
    if (def.kind === 'base') {
        return `base content (scripts/${toPosix(path.relative(contentScripts(), def.file))}:${def.block.line + 1})`;
    }
    if (def.kind === 'shadow') {
        return `${def.shadowOf}`;
    }
    return `mod ${def.modFile!.mod.name} (${def.modFile!.relPath}:${def.block.line + 1})`;
}

function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

function refError(ref: Ref, message: string) {
    return ModManager.error(ref.file, ref.index + 1, message);
}

// Staged files edited by this build (path -> lines), written in beforeCompile
const edits = new Map<string, string[]>();

function readLines(file: string): string[] {
    const edited = edits.get(file);
    if (edited) {
        return edited;
    }
    return splitSourceLines(fs.readFileSync(file, 'utf-8'));
}

function editLines(file: string): string[] {
    let lines = edits.get(file);
    if (!lines) {
        lines = splitSourceLines(fs.readFileSync(file, 'utf-8'));
        edits.set(file, lines);
    }
    return lines;
}

function safeDirName(name: string): string {
    return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function subjectCategory(config: SubjectConfig, subject: string): Promise<string | null | undefined> {
    // undefined: no such config; null: no category
    const loaders = {
        npc: async () => (await import('#/cache/config/NpcType.js')).default,
        obj: async () => (await import('#/cache/config/ObjType.js')).default,
        loc: async () => (await import('#/cache/config/LocType.js')).default
    };
    const type = await loaders[config]();
    if (!loadedConfigs.has(config)) {
        type.load('data/pack');
        loadedConfigs.add(config);
    }
    const found = type.getByName(subject);
    if (!found) {
        return undefined;
    }
    return found.category === -1 ? null : CategoryPack.getById(found.category);
}

const loadedConfigs = new Set<SubjectConfig>();

const capability: ModCapability = {
    name: 'script-overrides',

    afterRevalidate() {
        chains = [];
        shadowing = [];
        baseIndexCache = null;
        edits.clear();
        loadedConfigs.clear();

        const staged = stagedScripts();
        if (staged.length === 0) {
            return;
        }

        // [trigger,subject] -> mod definitions in load order (one per mod;
        // scripts.ts rejects a second definition in the same mod)
        const modDefs = new Map<string, Def[]>();
        // mod name -> its staged files with their lines
        const modFiles = new Map<string, { file: ModFile; staged: string; lines: string[] }[]>();

        for (const { file, staged: stagedPath } of staged) {
            const lines = splitSourceLines(fs.readFileSync(stagedPath, 'utf-8'));
            let files = modFiles.get(file.mod.name);
            if (!files) {
                files = [];
                modFiles.set(file.mod.name, files);
            }
            files.push({ file, staged: stagedPath, lines });

            for (const block of scanScriptBlocks(lines)) {
                let defs = modDefs.get(block.name);
                if (!defs) {
                    defs = [];
                    modDefs.set(block.name, defs);
                }
                defs.push({ kind: 'mod', file: stagedPath, block, modFile: file });
            }
        }

        const refsOf = (def: Def, name: string): Ref[] => {
            const out: Ref[] = [];
            for (const f of modFiles.get(def.modFile!.mod.name) ?? []) {
                for (const { index, sigil } of findReferences(f.lines, name)) {
                    out.push({ file: f.file, staged: f.staged, index, sigil });
                }
            }
            return out;
        };

        for (const [key, defs] of modDefs) {
            const { trigger, subject } = defs[0].block;
            const name0 = originalName(trigger, subject, 0);

            const entries: (Def | null)[] = [];
            if (ModManager.isBaseName(ScriptPack, key)) {
                const base = baseIndex().get(key);
                if (!base) {
                    throw new Error(`[mods] ${key} is a base script name but no base file defines it`);
                }
                entries.push({ kind: 'base', file: base.file, block: base.block });
            }
            entries.push(...defs);

            const refs: Ref[][] = entries.map(def => (def && def.kind === 'mod' ? refsOf(def, name0) : []));

            // The first mod definition references an original but replaces nothing
            if (entries[0]!.kind === 'mod' && refs[0].length > 0) {
                if (!SHADOW_SUBJECTS[trigger] || subject.startsWith('_')) {
                    throw refError(refs[0][0], `${key} does not replace an existing script, so ${refs[0][0].sigil}${name0} does not exist`);
                }
                // resolved in beforeCompile, when the subject's category is known
                entries.unshift(null);
                refs.unshift([]);
            }

            if (entries.length === 1) {
                if (SHADOW_SUBJECTS[trigger] && !subject.startsWith('_')) {
                    shadowing.push({ key, trigger, subject, mod: defs[0].modFile!.mod.name });
                }
                continue;
            }

            const last = entries.length - 1;
            const forms: Form[][] = [];
            for (let i = 0; i < last; i++) {
                const def = entries[i];
                const above = entries[i + 1]!;
                const name = originalName(trigger, subject, last - 1 - i);
                const sigils = new Set(refs[i + 1].map(r => r.sigil));

                // The override must keep the signature of what it replaces:
                // base content (and earlier mods) still call it.
                if (def) {
                    const expected = parseSignature(def.block.rest);
                    const actual = parseSignature(above.block.rest);
                    if (!sameSignature(expected, actual)) {
                        throw ModManager.error(above.modFile!, above.block.line + 1, `${key} must keep the signature ${formatSignature(expected)} of ${describe(def)}, found ${formatSignature(actual)}`);
                    }
                }

                const f: Form[] = [];
                if (def && isReturning(def)) {
                    const at = refs[i + 1].find(r => r.sigil === '@');
                    if (at) {
                        throw refError(at, `the original of ${key} is a proc (${def.block.trigger === 'proc' ? 'the original of a proc' : 'it returns a value'}): call it with ~${name0}`);
                    }
                    f.push('proc');
                } else {
                    if (sigils.has('@')) {
                        f.push('label');
                    }
                    if (sigils.has('~')) {
                        f.push('proc');
                        const jumps = def ? findLabelJumps(readLines(def.file), def.block) : [];
                        if (jumps.length > 0) {
                            const ref = refs[i + 1].find(r => r.sigil === '~')!;
                            throw refError(ref, `~${name0} cannot be a proc: ${key} in ${describe(def!)} jumps to labels (line ${jumps[0] + 1}). Jump to it with @${name0} instead`);
                        }
                    }
                    if (f.length === 0 && def) {
                        // nothing calls it, but the replaced block still has to be renamed
                        f.push('label');
                    }
                }
                forms.push(f);

                for (const form of f) {
                    const generated = scriptName(form, name);
                    if (ScriptPack.getByName(generated) !== -1) {
                        const owner = ModManager.isBaseName(ScriptPack, generated) ? 'base content' : 'a mod';
                        throw ModManager.error(above.modFile!, above.block.line + 1, `overriding ${key} generates ${generated}, but ${owner} already defines that script`);
                    }
                    ModManager.registerName('script', ScriptPack, generated);
                }

                if (def) {
                    const how = f.map(form => (form === 'label' ? '@' : '~') + name0).join(' / ');
                    const compiledAs = i < last - 1 ? ` (compiled as ${name}, because ${entries[last]!.modFile!.mod.name} overrides it again)` : '';
                    printInfo(`[mods] ${above.modFile!.mod.name} overrides ${key} from ${describe(def)}; its original: ${how}${compiledAs}`);
                }
            }

            chains.push({ key, trigger, subject, entries, refs, forms });
        }

        // original_<...> names belong to the mod that defines the script
        const owned = new Map<string, Set<string>>(); // generated name -> mods allowed to reference it
        for (const chain of chains) {
            const name0 = originalName(chain.trigger, chain.subject, 0);
            for (let i = 1; i < chain.entries.length; i++) {
                const def = chain.entries[i]!;
                let mods = owned.get(name0);
                if (!mods) {
                    mods = new Set();
                    owned.set(name0, mods);
                }
                mods.add(def.modFile!.mod.name);
            }
        }
        for (const [modName, files] of modFiles) {
            for (const f of files) {
                for (const ref of findPrefixedReferences(f.lines, 'original')) {
                    const mods = owned.get(ref.name);
                    if (mods && !mods.has(modName)) {
                        throw ModManager.error(f.file, ref.index + 1, `${ref.sigil}${ref.name} is the original of a script this mod does not define; only a mod that overrides that script can call its original`);
                    }
                    if (/^original\d+_/.test(ref.name)) {
                        throw ModManager.error(f.file, ref.index + 1, `${ref.sigil}${ref.name}: original<number>_ names are internal; use original_<trigger>_<subject>`);
                    }
                }
            }
        }
    },

    async beforeCompile(_ctx, compiler) {
        const root = ModManager.stagingDir('overrides');
        fs.rmSync(root, { recursive: true, force: true });
        if (chains.length === 0 && shadowing.length === 0) {
            return;
        }
        fs.mkdirSync(root, { recursive: true });

        // The winning definition of a key (for shadow sources)
        const winners = new Map<string, Def>();
        for (const chain of chains) {
            winners.set(chain.key, chain.entries[chain.entries.length - 1]!);
        }
        const winnerOf = (key: string): Def | null => {
            const won = winners.get(key);
            if (won) {
                return won;
            }
            const staged = stagedScripts();
            for (let i = staged.length - 1; i >= 0; i--) {
                const block = scanScriptBlocks(readLines(staged[i].staged)).find(b => b.name === key);
                if (block) {
                    return { kind: 'mod', file: staged[i].staged, block, modFile: staged[i].file };
                }
            }
            if (ModManager.isBaseName(ScriptPack, key)) {
                const base = baseIndex().get(key);
                return base ? { kind: 'base', file: base.file, block: base.block } : null;
            }
            return null;
        };

        // The script the engine would run for [trigger,subject] without it:
        // [trigger,_<category of subject>], else [trigger,_]
        const shadowed = async (trigger: string, subject: string): Promise<{ candidates: string[]; source: Def | null } | undefined> => {
            const config = SHADOW_SUBJECTS[trigger];
            const category = await subjectCategory(config, subject);
            if (category === undefined) {
                return undefined;
            }
            const candidates = [...(category ? [`[${trigger},_${category}]`] : []), `[${trigger},_]`];
            for (const candidate of candidates) {
                const source = winnerOf(candidate);
                if (source) {
                    return { candidates, source: { kind: 'shadow', file: source.file, block: source.block, shadowOf: `${candidate} (${describe(source)})` } };
                }
            }
            return { candidates, source: null };
        };

        for (const { key, trigger, subject, mod } of shadowing) {
            const found = await shadowed(trigger, subject);
            if (found?.source) {
                printInfo(`[mods] ${mod}'s ${key} takes precedence over ${found.source.shadowOf} for ${subject}; jump to @${originalName(trigger, subject, 0)} to run that script`);
            }
        }

        // 1. resolve shadows: the category script, else the default script
        for (const chain of chains) {
            if (chain.entries[0] !== null) {
                continue;
            }
            const ref = chain.refs[1][0];
            const name0 = originalName(chain.trigger, chain.subject, 0);
            const found = await shadowed(chain.trigger, chain.subject);
            if (found === undefined) {
                throw refError(ref, `${chain.key}: there is no ${SHADOW_SUBJECTS[chain.trigger]} named '${chain.subject}'`);
            }
            if (!found.source) {
                throw refError(ref, `${chain.key} does not replace or shadow a script (no ${found.candidates.join(' or ')}), so ${ref.sigil}${name0} does not exist`);
            }
            chain.entries[0] = found.source;
            const shadow = found.source;
            if (chain.forms[0].includes('proc')) {
                const jumps = findLabelJumps(readLines(shadow.file), shadow.block);
                if (jumps.length > 0) {
                    const tilde = chain.refs[1].find(r => r.sigil === '~')!;
                    throw refError(tilde, `~${name0} cannot be a proc: ${shadow.shadowOf} jumps to labels (line ${jumps[0] + 1}). Jump to it with @${name0} instead`);
                }
            }
            printInfo(`[mods] ${chain.entries[1]!.modFile!.mod.name} shadows ${shadow.shadowOf} for ${chain.key}; original: ${chain.forms[0].map(f => (f === 'label' ? '@' : '~') + name0).join(' / ')}`);
        }

        // 2. superseded mod blocks: rename in place; rewrite the references of
        //    superseded mods to the level below them
        for (const chain of chains) {
            const last = chain.entries.length - 1;
            const name0 = originalName(chain.trigger, chain.subject, 0);
            for (let i = 0; i < last; i++) {
                const def = chain.entries[i]!;
                if (def.kind === 'mod') {
                    const lines = editLines(def.file);
                    lines[def.block.line] = renameHeader(lines[def.block.line], scriptName(chain.forms[i][0], originalName(chain.trigger, chain.subject, last - 1 - i)));
                }
            }
            for (let i = 1; i < last; i++) {
                const def = chain.entries[i]!;
                if (chain.refs[i].length === 0) {
                    continue;
                }
                const target = originalName(chain.trigger, chain.subject, last - i);
                for (const file of new Set(chain.refs[i].map(r => r.staged))) {
                    replaceReferences(editLines(file), name0, target);
                }
                printInfo(`[mods] ${def.modFile!.mod.name}: ${name0} is compiled as ${target} (it is not the last override of ${chain.key})`);
            }
        }
        for (const [file, lines] of edits) {
            fs.writeFileSync(file, lines.join('\n'));
        }

        // 3. base files with replaced blocks: stage a renamed copy, omit the original
        const baseRenames = new Map<string, Map<number, string>>(); // base file -> line -> new name
        for (const chain of chains) {
            const def = chain.entries[0]!;
            if (def.kind !== 'base') {
                continue;
            }
            let renames = baseRenames.get(def.file);
            if (!renames) {
                renames = new Map();
                baseRenames.set(def.file, renames);
            }
            renames.set(def.block.line, scriptName(chain.forms[0][0], originalName(chain.trigger, chain.subject, chain.entries.length - 2)));
        }
        for (const [file, renames] of baseRenames) {
            const lines = splitSourceLines(fs.readFileSync(file, 'utf-8'));
            for (const [line, name] of renames) {
                lines[line] = renameHeader(lines[line], name);
            }
            const dest = path.join(root, 'base', path.relative(contentScripts(), file));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, lines.join('\n'));
            compiler.omit.push(file);
        }

        // 4. copies: shadows, and the second form of a renamed block. Blank
        //    lines in front keep the line numbers of the source file.
        for (const chain of chains) {
            const last = chain.entries.length - 1;
            for (let i = 0; i < last; i++) {
                const def = chain.entries[i]!;
                const copies = def.kind === 'shadow' ? chain.forms[i] : chain.forms[i].slice(1);
                const name = originalName(chain.trigger, chain.subject, last - 1 - i);
                for (const form of copies) {
                    const lines = readLines(def.file);
                    const out = new Array<string>(def.block.line).fill('');
                    out.push(renameHeader(lines[def.block.line], scriptName(form, name)));
                    out.push(...lines.slice(def.block.line + 1, def.block.end));
                    const dest = path.join(root, 'copies', safeDirName(`${form}_${name}`), path.basename(def.file));
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.writeFileSync(dest, out.join('\n'));
                }
            }
        }

        if (fs.readdirSync(root).length > 0) {
            compiler.sources.push(root);
        }
    }
};

export default capability;
