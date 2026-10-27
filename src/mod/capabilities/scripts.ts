// Capability: RuneScript.
//
// Mod layout: scripts/**/*.rs2. Each [trigger,subject] block gets a stable id
// in the script pack (idmap kind 'script'), after base content.
//
// Mod scripts are staged, never copied into the content dir:
//   data/pack/mods/scripts/<mod name>/<path under the mod's scripts/>
// The staged directory is added to the compiler sources in beforeCompile,
// next to the base content scripts. Compiler errors therefore show the staged
// path, which names the mod and the file's path inside its scripts/ folder.
//
// A [trigger,subject] that base content (or another mod) already defines is an
// error for now. Script overrides are a separate capability: it can stage a
// rewritten copy of a base file and add the original file to
// CompilerConfig.excluded in its own beforeCompile hook.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';
import { ScriptPack } from '#tools/pack/PackFile.js';
import { loadFile, loadFileFull } from '#tools/pack/Parse.js';

interface StagedScript {
    file: ModFile;
    staged: string;
}

let staged: StagedScript[] = [];

// Root of the staged mod scripts (data/pack/mods/scripts)
export function scriptStagingRoot(): string {
    return ModManager.stagingDir('scripts');
}

// [trigger,subject] headers of a script file with 1-based line numbers. The
// names come from loadFileFull, exactly like crawlConfigNames('.rs2', true) in
// tools/pack/PackFile.ts; the line numbers are looked up in the raw file.
export function scanScriptHeaders(file: string): { name: string; line: number }[] {
    const raw = loadFile(file);
    const headers: { name: string; line: number }[] = [];
    let from = 0;
    for (const line of loadFileFull(file)) {
        if (!line.startsWith('[')) {
            continue;
        }
        const name = line.substring(0, line.indexOf(']') + 1);
        let at = raw.findIndex((l, i) => i >= from && l.trim().startsWith(name));
        if (at === -1) {
            at = from;
        }
        from = at + 1;
        headers.push({ name, line: at + 1 });
    }
    return headers;
}

const capability: ModCapability = {
    name: 'scripts',

    prepare() {
        // An older version of the mod loader copied mod scripts into the
        // content repo. They would now be compiled twice.
        const legacy = path.join(Environment.BUILD_SRC_DIR, 'scripts', '_mods');
        if (fs.existsSync(legacy)) {
            throw new Error(`${legacy} was created by an older version of the mod loader. Delete it: mod scripts are now staged in data/pack/mods/scripts.`);
        }

        const root = scriptStagingRoot();
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });

        staged = [];
        for (const file of ModManager.listFiles('scripts', '.rs2')) {
            const dest = path.join(root, file.mod.name, ...file.subPath.split('/'));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(file.path, dest);
            staged.push({ file, staged: dest });
        }
    },

    // Give every mod script a stable id in the (in-memory) script pack. The
    // base script.pack in the content dir only ever holds base scripts.
    afterRevalidate() {
        const defined = new Map<string, { file: ModFile; line: number }>();

        for (const { file } of staged) {
            for (const { name, line } of scanScriptHeaders(file.path)) {
                const first = defined.get(name);
                if (first) {
                    const where = first.file.mod === file.mod ? `${first.file.relPath}:${first.line}` : `mod ${first.file.mod.name} (${first.file.relPath}:${first.line})`;
                    throw ModManager.error(file, line, `${name} is already defined by ${where}`);
                }
                defined.set(name, { file, line });

                if (ModManager.isBaseName(ScriptPack, name)) {
                    throw ModManager.error(file, line, `${name} is already defined by base content (replacing base scripts is not supported by this capability)`);
                }

                ModManager.registerName('script', ScriptPack, name);
            }
        }
    },

    beforeCompile(_ctx, compiler) {
        if (staged.length > 0) {
            compiler.sources.push(scriptStagingRoot());
        }
    }
};

export default capability;
