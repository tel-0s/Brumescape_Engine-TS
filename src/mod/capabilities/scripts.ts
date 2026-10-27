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
// A [trigger,subject] that base content or an earlier mod already defines is
// an override. This capability only registers the name (the existing id is
// kept); script-overrides.ts (slot A) removes the replaced block from
// compilation and generates the "original" label/proc. Defining the same
// [trigger,subject] twice in one mod is an error.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { scanScriptBlocks, splitSourceLines } from '#/mod/RuneScriptSource.js';
import Environment from '#/util/Environment.js';
import { ScriptPack } from '#tools/pack/PackFile.js';

export interface StagedScript {
    file: ModFile;
    // Absolute path of the staged copy (the compiler reads this one)
    staged: string;
}

let staged: StagedScript[] = [];

// Root of the staged mod scripts (data/pack/mods/scripts)
export function scriptStagingRoot(): string {
    return ModManager.stagingDir('scripts');
}

// The mod script files staged for this build, mod by mod in load order
export function stagedScripts(): readonly StagedScript[] {
    return staged;
}

// [trigger,subject] headers of a script file with 1-based line numbers.
// Headers inside comments are skipped, like crawlConfigNames does for base
// scripts.
export function scanScriptHeaders(file: string): { name: string; line: number }[] {
    return scanScriptBlocks(splitSourceLines(fs.readFileSync(file, 'utf-8'))).map(b => ({ name: b.name, line: b.line + 1 }));
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
    // base script.pack in the content dir only ever holds base scripts. A name
    // that base content or an earlier mod already has keeps its id (override).
    afterRevalidate() {
        // per mod: name -> where this mod first defined it
        const defined = new Map<string, { file: ModFile; line: number }>();

        for (const { file } of staged) {
            for (const { name, line } of scanScriptHeaders(file.path)) {
                if (name.startsWith('[command,')) {
                    throw ModManager.error(file, line, `${name}: command signatures belong to the engine (scripts/engine.rs2) and cannot be defined by mods`);
                }

                const key = `${file.mod.name}\n${name}`;
                const first = defined.get(key);
                if (first) {
                    throw ModManager.error(file, line, `${name} is already defined by this mod (${first.file.relPath}:${first.line})`);
                }
                defined.set(key, { file, line });

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
