// Capability: models from Wavefront OBJ files (model authoring).
//
// Mod layout: models/**/<name>.obj, its .mtl (mtllib, relative to the OBJ),
// and an optional models/**/<name>.json with conversion options:
//   { "scale": 128, "labels": { "<group>": <label> }, "rig": "<animset>",
//     "priority": 0, "faceLabels": false }
// "rig" names a bone-form animset (anims/<animset>.json in any enabled mod):
// a group named after a bone gets that bone's first label.
//
// The OBJ is converted at build time (tools/pack/graphics/ObjModel.ts) into
// data/pack/mods/models/<name>.ob2 and packed like a models/<name>.ob2 file:
// a new name gets a stable model id, a base name replaces that model, and the
// later mod in load order wins over .ob2 and .obj files alike.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { printInfo, printWarning } from '#/util/Logger.js';
import { AnimSourceError, parseAnimSetSource } from '#tools/pack/graphics/AnimSource.js';
import { encodeOb2 } from '#tools/pack/graphics/Ob2.js';
import { convertObj, ObjError } from '#tools/pack/graphics/ObjModel.js';
import { JsonSyntaxError, parseJsonWithLines } from '#tools/pack/graphics/JsonLines.js';
import { ModelPack, TexturePack } from '#tools/pack/PackFile.js';

export interface ObjModelOptions {
    scale?: number;
    labels?: Record<string, number>;
    rig?: string;
    priority?: number;
    faceLabels?: boolean;
}

// Options from <name>.json next to the OBJ (null if there is none)
export function readObjModelOptions(jsonPath: string): { options: ObjModelOptions; error: { message: string; line: number | null } | null } {
    let doc;
    try {
        doc = parseJsonWithLines(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (err) {
        if (err instanceof JsonSyntaxError) {
            return { options: {}, error: { message: `invalid JSON: ${err.message}`, line: err.line } };
        }
        throw err;
    }
    const value = doc.value as Record<string, unknown>;
    const bad = (message: string) => ({ options: {}, error: { message, line: 1 } });
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return bad('model options must be a JSON object');
    }
    for (const key of Object.keys(value)) {
        if (!['scale', 'labels', 'rig', 'priority', 'faceLabels', 'comment'].includes(key)) {
            return bad(`unknown key "${key}" (allowed: scale, labels, rig, priority, faceLabels, comment)`);
        }
    }
    if (value.scale !== undefined && (typeof value.scale !== 'number' || !(value.scale > 0))) {
        return bad('"scale" must be a positive number');
    }
    if (value.labels !== undefined) {
        if (typeof value.labels !== 'object' || value.labels === null || Array.isArray(value.labels)) {
            return bad('"labels" must be { "<group>": <label> }');
        }
        for (const [group, label] of Object.entries(value.labels)) {
            if (typeof label !== 'number' || !Number.isInteger(label) || label < 0 || label > 255) {
                return bad(`"labels": "${group}" must be a label from 0 to 255`);
            }
        }
    }
    if (value.rig !== undefined && typeof value.rig !== 'string') {
        return bad('"rig" must be the name of a bone-form animset');
    }
    if (value.priority !== undefined && (typeof value.priority !== 'number' || !Number.isInteger(value.priority) || value.priority < 0 || value.priority > 11)) {
        return bad('"priority" must be a whole number from 0 to 11');
    }
    if (value.faceLabels !== undefined && typeof value.faceLabels !== 'boolean') {
        return bad('"faceLabels" must be true or false');
    }
    return { options: value as ObjModelOptions, error: null };
}

// group name -> label for a rig (bone-form animset source text)
export function rigLabels(text: string): Map<string, number> {
    const source = parseAnimSetSource(text);
    if (!source.bones) {
        throw new AnimSourceError('is not a bone-form animset ("bones"), so it cannot be a rig', null);
    }
    const labels = new Map<string, number>();
    for (const bone of source.bones) {
        if (bone.labels.length) {
            labels.set(bone.name, bone.labels[0]);
        }
    }
    return labels;
}

const capability: ModCapability = {
    name: 'obj-models',

    // After the textures capability (texture names) and the models capability
    // (.ob2 files): an OBJ that wins its name replaces what models set.
    afterRevalidate() {
        const objs = ModManager.listFiles('models', '.obj');
        const staging = ModManager.stagingDir('models');
        for (const old of fs.readdirSync(staging)) {
            fs.rmSync(path.join(staging, old), { recursive: true, force: true });
        }
        if (!objs.length) {
            return;
        }

        // the last definition of each name in load order, over .ob2 and .obj
        const order = new Map(ModManager.mods.map((mod, i) => [mod, i]));
        const winner = new Map<string, ModFile>();
        const ob2s = ModManager.listFiles('models', '.ob2');
        for (const file of [...ob2s, ...objs].sort((a, b) => order.get(a.mod)! - order.get(b.mod)!)) {
            const previous = winner.get(file.name);
            if (previous && previous.mod === file.mod) {
                throw ModManager.error(file, null, `model ${file.name} is also defined by ${previous.relPath}`);
            }
            winner.set(file.name, file);
        }

        const rigs = new Map<string, ModFile>();
        for (const file of ModManager.listFiles('anims', '.json')) {
            rigs.set(file.name, file);
        }

        for (const file of objs) {
            const last = winner.get(file.name)!;
            if (last !== file) {
                printWarning(`[mods] model '${file.name}' from ${file.mod.name} (${file.relPath}) is overridden by ${last.mod.name} (${last.relPath})`);
                continue;
            }
            const previous = ModManager.claim('model', file.name, file);
            if (previous && previous.mod === file.mod && previous !== file) {
                throw ModManager.error(file, null, `model ${file.name} is also defined by ${previous.relPath}`);
            }

            const optionsPath = file.path.replace(/\.obj$/i, '.json');
            let options: ObjModelOptions = {};
            if (fs.existsSync(optionsPath)) {
                const read = readObjModelOptions(optionsPath);
                if (read.error) {
                    throw ModManager.error({ ...file, relPath: file.relPath.replace(/\.obj$/i, '.json') }, read.error.line, read.error.message);
                }
                options = read.options;
            }

            const labels = new Map<string, number>();
            if (options.rig !== undefined) {
                const rigFile = rigs.get(options.rig);
                if (!rigFile) {
                    throw ModManager.error(file, null, `"rig": "${options.rig}" is not an animset in anims/ of an enabled mod`);
                }
                try {
                    for (const [bone, label] of rigLabels(fs.readFileSync(rigFile.path, 'utf-8'))) {
                        labels.set(bone, label);
                    }
                } catch (err) {
                    if (err instanceof AnimSourceError) {
                        throw ModManager.error(rigFile, err.line, err.message);
                    }
                    throw err;
                }
            }
            for (const [group, label] of Object.entries(options.labels ?? {})) {
                labels.set(group, label);
            }

            let result;
            try {
                result = convertObj(fs.readFileSync(file.path, 'utf-8'), file.relPath, {
                    scale: options.scale,
                    labels,
                    strictLabels: labels.size > 0,
                    priority: options.priority,
                    faceLabels: options.faceLabels,
                    texture: name => (TexturePack.getByName(name) === -1 ? undefined : TexturePack.getByName(name)),
                    readMtl: name => {
                        const mtl = path.resolve(path.dirname(file.path), name);
                        return fs.existsSync(mtl) ? fs.readFileSync(mtl, 'utf-8') : null;
                    }
                });
            } catch (err) {
                if (err instanceof ObjError) {
                    const where = err.file === file.relPath ? file : { ...file, relPath: path.posix.join(path.posix.dirname(file.relPath), err.file) };
                    throw ModManager.error(where, err.line, err.message);
                }
                throw err;
            }
            for (const warning of result.warnings) {
                ModManager.warn(file, null, warning);
            }

            let data: Uint8Array;
            try {
                data = encodeOb2(result.model);
            } catch (err) {
                throw ModManager.error(file, null, (err as Error).message);
            }
            const target = path.join(staging, `${file.name}.ob2`);
            fs.writeFileSync(target, data);

            if (ModManager.isBaseName(ModelPack, file.name)) {
                printInfo(`[mods] ${file.mod.name} replaces base model ${file.name}`);
            }
            ModManager.registerName('model', ModelPack, file.name);
            ModManager.setAsset('model', file.name, target);
        }
    }
};

export default capability;
