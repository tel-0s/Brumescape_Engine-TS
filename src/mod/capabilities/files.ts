// Capability: report mod files that the build does not read.
//
// Registered last, so its afterRevalidate runs after every capability has
// listed its files (ModManager.listFiles in prepare or afterRevalidate). A
// file of an enabled mod that nothing listed would be left out of the build
// without a word, and the only symptom would be a later "unknown symbol":
//   - a build file in the wrong folder stops the build, for example
//     scripts/configs/guard.npc (base content's layout), script/quest.rs2,
//     music/theme.mid
//   - any other file gets a warning, for example config/quest.const or
//     models/rock.png
// Not reported: mod.json, spawns.json, notes (*.md, *.txt, LICENSE, ...), the
// source/ folder (the author's own sources, such as Blender files), and
// the side files that capabilities read next to a listed file: meta/<name>.opt
// and meta/<name>.pal.png of sprites, textures and title sprites, and the
// .mtl files and <name>.json options of OBJ models.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';

const FOLDERS = ['config', 'scripts', 'interfaces', 'sprites', 'models', 'textures', 'anims', 'maps', 'synth', 'songs', 'jingles', 'title', 'binary'];

const CONFIG_EXTENSIONS = ['.npc', '.obj', '.loc', '.seq', '.spotanim', '.idk', '.enum', '.struct', '.hunt', '.mesanim', '.varp', '.varn', '.vars', '.param', '.inv', '.dbtable', '.dbrow', '.flo', '.constant'];

// extension -> the folders it is read from
const HOMES: Record<string, string[]> = {
    '.rs2': ['scripts'],
    '.if': ['interfaces'],
    '.ifpatch': ['interfaces'],
    '.jm2': ['maps'],
    '.synth': ['synth'],
    '.mid': ['songs', 'jingles'],
    '.ob2': ['models']
};
for (const ext of CONFIG_EXTENSIONS) {
    HOMES[ext] = ['config'];
}
HOMES['.obj'] = ['config', 'models']; // obj configs and Wavefront OBJ models

const NOTE_NAMES = /^(readme|license|licence|copying|notice|credits|authors|changelog)$/i;

function isSideFile(rel: string, file: string): boolean {
    const parts = rel.split('/');
    const ext = path.extname(rel).toLowerCase();
    const base = path.basename(rel, path.extname(rel));

    if (rel === 'mod.json' || rel === 'spawns.json') {
        return true;
    }
    if (ext === '.md' || ext === '.txt' || NOTE_NAMES.test(base)) {
        return true;
    }
    // source/: the author's own sources (Blender files and scripts, image
    // layers, ...) that the build does not read
    if (parts[0] === 'source') {
        return true;
    }
    // meta/<name>.opt, meta/<name>.pal.png next to a sprite, texture or title sprite
    if (['sprites', 'textures', 'title'].includes(parts[0]) && parts[parts.length - 2] === 'meta' && (ext === '.opt' || ext === '.png')) {
        return true;
    }
    if (parts[0] === 'models') {
        if (ext === '.mtl') {
            return true;
        }
        // <name>.json options of models/**/<name>.obj
        if (ext === '.json' && fs.existsSync(path.join(path.dirname(file), `${base}.obj`))) {
            return true;
        }
    }
    return false;
}

const capability: ModCapability = {
    name: 'files',

    afterRevalidate() {
        for (const mod of ModManager.mods) {
            for (const file of ModManager.listModFiles(mod)) {
                if (ModManager.wasListed(file)) {
                    continue;
                }
                const rel = path.relative(mod.dir, file).split(path.sep).join('/');
                if (isSideFile(rel, file)) {
                    continue;
                }

                const ext = path.extname(rel).toLowerCase();
                const where: ModFile = { mod, path: file, relPath: rel, subPath: rel, name: path.basename(rel, path.extname(rel)), ext };
                const homes = HOMES[ext];
                if (homes) {
                    const folders = homes.map(h => `${h}/`).join(' or ');
                    throw ModManager.error(where, null, `${ext} files are only read under ${folders} in a mod (any subfolders), so this file would be left out of the build. Move it there.`);
                }

                const folder = rel.includes('/') ? rel.split('/')[0] : null;
                const why = folder !== null && !FOLDERS.includes(folder) ? `nothing reads the folder ${folder}/` : `nothing reads ${ext ? `${ext} files` : 'files without an extension'} here`;
                ModManager.warn(where, null, `not used by the build (${why}). See "Folder layout" in MODDING.md.`);
            }
        }
    }
};

export default capability;
