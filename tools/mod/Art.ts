// Model and animation authoring tools for mod authors: bun run mod:art <command>
//
// Converts and inspects the formats the anims and obj-models capabilities
// read (src/mod/capabilities/anims.ts, objmodels.ts). Run `bun run mod:art`
// for the command list.

import fs from 'fs';
import path from 'path';

import kleur from 'kleur';

import { readObjModelOptions, rigLabels } from '#/mod/capabilities/objmodels.js';
import Environment from '#/util/Environment.js';
import { ANIM_OP_NAMES, AnimBaseDef, decodeAnimSet, encodeAnimSet, expandFrame, readAnimSetFrameIds } from '#tools/pack/graphics/AnimSet.js';
import { animSetToJson, AnimSourceError, parseAnimSetSource, resolveFrames } from '#tools/pack/graphics/AnimSource.js';
import { decodeOb2, encodeOb2, Ob2Model } from '#tools/pack/graphics/Ob2.js';
import { convertObj, ObjError, rgbToHsl16 } from '#tools/pack/graphics/ObjModel.js';

const USAGE = `Usage: bun run mod:art <command> [arguments]

Models
  obj <in.obj> [out.ob2] [options]   convert a Wavefront OBJ (+ its .mtl) to .ob2
      --scale <n>        OBJ units to model units (default 128: 1 unit = 1 tile)
      --rig <file.json>  a bone-form animset: groups named after bones get their labels
      --labels a=1,b=2   group -> vertex label
      --priority <n>     render priority of every face (0-11, default 0)
      --face-labels      also write face labels (for alpha animations)
      Options default to <in>.json next to the OBJ, like the build reads them.
      Texture names (map_Kd) resolve against base textures and BUILD_MODS_DIR's idmap.
  model <file.ob2 | base model name>   summary: counts, labels (bounds, centre), colours

Animations
  anim-unpack <anim_N | file.anim> [out.json]   an animset as base-form JSON with frame names
  anim-check <file.json>             parse, compile and validate an animset source; prints its base and frames
  anim-find <frame name | id>        which base animset holds a frame

Checks
  selftest                           round-trip every base model and animset through the codecs,
                                     and random OBJ meshes through the OBJ converter`;

const content = Environment.BUILD_SRC_DIR;

function fail(message: string): never {
    console.error(kleur.red(message));
    process.exit(1);
}

function readPack(type: string): Map<number, string> {
    const out = new Map<number, string>();
    const file = path.join(content, 'pack', `${type}.pack`);
    if (!fs.existsSync(file)) {
        return out;
    }
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            out.set(parseInt(line.substring(0, eq)), line.substring(eq + 1));
        }
    }
    return out;
}

function findFile(dir: string, name: string): string | null {
    if (!fs.existsSync(dir)) {
        return null;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) {
                return found;
            }
        } else if (entry.name === name) {
            return full;
        }
    }
    return null;
}

// <mod root>/anims/**/<name>.json for an OBJ inside a mod folder
function findRig(objFile: string, name: string): string | null {
    for (let dir = path.dirname(path.resolve(objFile)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'mod.json'))) {
            return findFile(path.join(dir, 'anims'), `${name}.json`);
        }
    }
    return null;
}

function parseOptions(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].substring(2);
            if (key === 'face-labels') {
                flags.set(key, true);
            } else {
                if (i + 1 >= args.length) {
                    fail(`--${key} needs a value`);
                }
                flags.set(key, args[++i]);
            }
        } else {
            positional.push(args[i]);
        }
    }
    return { positional, flags };
}

// texture name -> id: base textures, then mod textures from the idmap
function textureResolver(): (name: string) => number | undefined {
    const names = new Map<string, number>();
    for (const [id, name] of readPack('texture')) {
        names.set(name, id);
    }
    const idmap = path.join(Environment.BUILD_MODS_DIR, 'idmap.json');
    if (fs.existsSync(idmap)) {
        const ids = JSON.parse(fs.readFileSync(idmap, 'utf-8')) as Record<string, { ids?: Record<string, number> }>;
        for (const [name, id] of Object.entries(ids.texture?.ids ?? {})) {
            if (!names.has(name)) {
                names.set(name, id);
            }
        }
    }
    return name => names.get(name);
}

function describeModel(model: Ob2Model) {
    const vertices = model.vertexX.length;
    console.log(`${vertices} vertices, ${model.faceA.length} faces, ${model.texP.length} texture mappings, priority ${model.facePriority ? 'per face' : model.priority}`);
    const byLabel = new Map<number, number[]>();
    for (let v = 0; v < vertices; v++) {
        const label = model.vertexLabel ? model.vertexLabel[v] : 0;
        if (!byLabel.has(label)) {
            byLabel.set(label, []);
        }
        byLabel.get(label)!.push(v);
    }
    console.log(model.vertexLabel ? 'vertex labels (model units: y down, the front is -z):' : 'no vertex labels (cannot be animated):');
    for (const [label, list] of [...byLabel].sort((a, b) => a[0] - b[0])) {
        const axis = (arr: number[]) => {
            const values = list.map(v => arr[v]);
            return { min: Math.min(...values), max: Math.max(...values), mid: Math.round(values.reduce((a, b) => a + b, 0) / values.length) };
        };
        const [x, y, z] = [axis(model.vertexX), axis(model.vertexY), axis(model.vertexZ)];
        console.log(`  label ${String(label).padStart(3)}: ${String(list.length).padStart(4)} vertices  centre ${x.mid},${y.mid},${z.mid}  x ${x.min}..${x.max}  y ${y.min}..${y.max}  z ${z.min}..${z.max}`);
    }
    const colours = new Map<number, number>();
    const textures = new Map<number, number>();
    model.faceColour.forEach((colour, f) => {
        const textured = model.faceInfo !== null && (model.faceInfo[f] & 2) !== 0;
        const map = textured ? textures : colours;
        map.set(colour, (map.get(colour) ?? 0) + 1);
    });
    console.log(`colours (hsl16: faces): ${[...colours].map(([c, n]) => `${c}: ${n}`).join(', ') || 'none'}`);
    if (textures.size) {
        console.log(`textures (id: faces): ${[...textures].map(([c, n]) => `${c}: ${n}`).join(', ')}`);
    }
}

function objCommand(args: string[]) {
    const { positional, flags } = parseOptions(args);
    const [input, output] = positional;
    if (!input) {
        fail('obj needs an input .obj file');
    }

    const optionsFile = input.replace(/\.obj$/i, '.json');
    const options = fs.existsSync(optionsFile) ? readObjModelOptions(optionsFile) : { options: {}, error: null };
    if (options.error) {
        fail(`${optionsFile}:${options.error.line}: ${options.error.message}`);
    }
    const scale = flags.has('scale') ? Number(flags.get('scale')) : options.options.scale;
    const labels = new Map<string, number>();
    const rig = (flags.get('rig') as string | undefined) ?? (options.options.rig !== undefined ? findRig(input, options.options.rig) : undefined);
    if (options.options.rig !== undefined && !rig) {
        fail(`rig ${options.options.rig}: no ${options.options.rig}.json found in this mod (pass --rig <file>)`);
    }
    if (rig) {
        try {
            for (const [bone, label] of rigLabels(fs.readFileSync(rig, 'utf-8'))) {
                labels.set(bone, label);
            }
        } catch (err) {
            fail(`${rig}: ${(err as Error).message}`);
        }
    }
    for (const [group, label] of Object.entries(options.options.labels ?? {})) {
        labels.set(group, label);
    }
    if (flags.has('labels')) {
        for (const pair of (flags.get('labels') as string).split(',')) {
            const [group, label] = pair.split('=');
            labels.set(group, parseInt(label));
        }
    }

    let result;
    try {
        result = convertObj(fs.readFileSync(input, 'utf-8'), input, {
            scale,
            labels,
            strictLabels: labels.size > 0,
            priority: flags.has('priority') ? parseInt(flags.get('priority') as string) : options.options.priority,
            faceLabels: flags.has('face-labels') || options.options.faceLabels,
            texture: textureResolver(),
            readMtl: name => {
                const mtl = path.resolve(path.dirname(input), name);
                return fs.existsSync(mtl) ? fs.readFileSync(mtl, 'utf-8') : null;
            }
        });
    } catch (err) {
        if (err instanceof ObjError) {
            fail(`${err.file}${err.line !== null ? `:${err.line}` : ''}: ${err.message}`);
        }
        throw err;
    }
    for (const warning of result.warnings) {
        console.log(kleur.yellow(`warning: ${warning}`));
    }
    const data = encodeOb2(result.model);
    const target = output ?? input.replace(/\.obj$/i, '.ob2');
    fs.writeFileSync(target, data);
    console.log(kleur.green(`wrote ${target} (${data.length} bytes)`));
    console.log(`groups -> labels: ${[...result.groups].map(([g, l]) => `${g || '(none)'}=${l}`).join(', ')}`);
    describeModel(decodeOb2(data));
}

function modelCommand(args: string[]) {
    const [name] = args;
    if (!name) {
        fail('model needs a .ob2 file or a base model name');
    }
    const file = fs.existsSync(name) ? name : findFile(path.join(content, 'models'), `${name}.ob2`);
    if (!file) {
        fail(`no file ${name} and no base model ${name}`);
    }
    console.log(kleur.bold(file));
    describeModel(decodeOb2(new Uint8Array(fs.readFileSync(file))));
}

function animUnpackCommand(args: string[]) {
    const [name, output] = args;
    if (!name) {
        fail('anim-unpack needs an animset name (anim_<n>) or a .anim file');
    }
    const file = fs.existsSync(name) ? name : findFile(path.join(content, 'models'), `${name}.anim`);
    if (!file) {
        fail(`no file ${name} and no base animset ${name}`);
    }
    const frameNames = readPack('anim');
    const set = decodeAnimSet(new Uint8Array(fs.readFileSync(file)));
    const json = animSetToJson(
        set.base,
        set.frames.map(f => ({ name: frameNames.get(f.id) ?? `frame_${f.id}`, delay: f.delay, transforms: f.transforms }))
    );
    if (output) {
        fs.writeFileSync(output, json);
        console.log(kleur.green(`wrote ${output}: ${set.base.types.length} groups, ${set.frames.length} frames`));
    } else {
        process.stdout.write(json);
    }
}

function animCheckCommand(args: string[]) {
    const [file] = args;
    if (!file) {
        fail('anim-check needs an animset .json file');
    }
    try {
        const source = parseAnimSetSource(fs.readFileSync(file, 'utf-8'));
        let base: AnimBaseDef;
        if (source.base) {
            base = source.base;
        } else {
            // a base reference: base content only (mod sets are resolved by the build)
            const setName = source.baseRef?.startsWith('base_') ? `anim_${source.baseRef.substring(5)}` : (source.baseRef ?? path.basename(file, '.json'));
            const baseFile = findFile(path.join(content, 'models'), `${setName}.anim`);
            if (!baseFile) {
                fail(`"base": ${JSON.stringify(source.baseRef)} is not in base content; the build also accepts mod animset names`);
            }
            base = decodeAnimSet(new Uint8Array(fs.readFileSync(baseFile))).base;
        }
        const frames = resolveFrames(source, base, source.groupNames);
        const groupName = new Map([...source.groupNames].map(([n, i]) => [i, n]));
        console.log(kleur.bold(`${file}: ${source.form} form, ${base.types.length} groups, ${frames.length} frames`));
        base.types.forEach((type, i) => console.log(`  group ${String(i).padStart(3)} ${(ANIM_OP_NAMES[type] ?? type).toString().padEnd(9)} labels [${base.labels[i].join(', ')}]${groupName.has(i) ? `  ${groupName.get(i)}` : ''}`));
        for (const frame of frames) {
            const applied = expandFrame(base, { id: 0, delay: frame.delay, transforms: frame.transforms });
            console.log(`  frame ${frame.name} (delay ${frame.delay}): ${applied.map(t => `${t.group}:${t.x},${t.y},${t.z}`).join('  ') || '(rest pose)'}`);
        }
        const data = encodeAnimSet({ base, frames: frames.map((f, i) => ({ id: i, delay: f.delay, transforms: f.transforms })) });
        console.log(kleur.green(`ok: encodes to ${data.length} bytes`));
    } catch (err) {
        if (err instanceof AnimSourceError) {
            fail(`${file}${err.line !== null ? `:${err.line}` : ''}: ${err.message}`);
        }
        throw err;
    }
}

function animFindCommand(args: string[]) {
    const [query] = args;
    if (!query) {
        fail('anim-find needs a frame name or id');
    }
    const frames = readPack('anim');
    const id = /^\d+$/.test(query) ? parseInt(query) : [...frames].find(([, name]) => name === query)?.[0];
    if (id === undefined) {
        fail(`no base frame named ${query}`);
    }
    for (const [setId, setName] of readPack('animset')) {
        const file = findFile(path.join(content, 'models'), `${setName}.anim`);
        if (file && readAnimSetFrameIds(new Uint8Array(fs.readFileSync(file))).includes(id)) {
            console.log(`frame ${frames.get(id) ?? id} (id ${id}) is in base animset ${setName} (id ${setId}, base base_${setId})`);
            return;
        }
    }
    fail(`frame ${query} is in no base animset`);
}

function listContent(dir: string, ext: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            listContent(full, ext, out);
        } else if (entry.name.endsWith(ext)) {
            out.push(full);
        }
    }
    return out;
}

async function selftestCommand() {
    const { default: Model } = await import('#/cache/graphics/Model.js');
    const { default: AnimFrame } = await import('#/cache/graphics/AnimFrame.js');
    let failures = 0;
    const report = (ok: boolean, message: string) => {
        console.log(ok ? kleur.green(`ok - ${message}`) : kleur.red(`FAIL - ${message}`));
        failures += ok ? 0 : 1;
    };

    // models: decode -> encode gives the same bytes; the engine's decoder agrees
    const models = listContent(path.join(content, 'models'), '.ob2');
    let sameBytes = 0;
    let decoderAgrees = 0;
    models.forEach((file, id) => {
        const data = new Uint8Array(fs.readFileSync(file));
        const model = decodeOb2(data);
        if (Buffer.compare(Buffer.from(encodeOb2(model)), Buffer.from(data)) === 0) {
            sameBytes++;
        }
        Model.unpack(id, data);
        const engine = Model.fromId(id);
        let ok = engine.vertexCount === model.vertexX.length && engine.faceCount === model.faceA.length && engine.texturedFaceCount === model.texP.length;
        for (let v = 0; ok && v < engine.vertexCount; v++) {
            ok = engine.vertexX![v] === model.vertexX[v] && engine.vertexY![v] === model.vertexY[v] && engine.vertexZ![v] === model.vertexZ[v] && (model.vertexLabel === null || engine.vertexLabel![v] === model.vertexLabel[v]);
        }
        for (let f = 0; ok && f < engine.faceCount; f++) {
            ok = engine.faceVertexA![f] === model.faceA[f] && engine.faceVertexB![f] === model.faceB[f] && engine.faceVertexC![f] === model.faceC[f] && engine.faceColour![f] === model.faceColour[f];
        }
        if (ok) {
            decoderAgrees++;
        }
    });
    report(sameBytes === models.length, `${sameBytes}/${models.length} base models re-encode to the same bytes`);
    report(decoderAgrees === models.length, `${decoderAgrees}/${models.length} base models decode the same with the engine's Model`);

    // animsets: decode -> encode -> decode is identical; the server's decoder agrees
    const sets = listContent(path.join(content, 'models'), '.anim');
    let sameSets = 0;
    let frames = 0;
    let serverAgrees = 0;
    for (const file of sets) {
        const data = new Uint8Array(fs.readFileSync(file));
        const set = decodeAnimSet(data);
        if (JSON.stringify(decodeAnimSet(encodeAnimSet(set))) === JSON.stringify(set)) {
            sameSets++;
        }
        AnimFrame.unpack(data);
        for (const frame of set.frames) {
            frames++;
            const server = AnimFrame.instances[frame.id];
            const expanded = expandFrame(set.base, frame);
            if (server && server.delay === frame.delay && server.length === expanded.length && expanded.every((e, i) => server.groups[i] === e.group && server.x[i] === e.x && server.y[i] === e.y && server.z[i] === e.z)) {
                serverAgrees++;
            }
        }
    }
    report(sameSets === sets.length, `${sameSets}/${sets.length} base animsets re-encode to the same frames and base`);
    report(serverAgrees === frames, `${serverAgrees}/${frames} base frames: the server's AnimFrame applies what the codec says`);

    // OBJ converter: random meshes keep positions (x, -y, -z) * scale, the
    // group label of every face vertex, colours and winding
    let random = 12345;
    const next = () => {
        random = (random * 1103515245 + 12345) & 0x7fffffff;
        return random / 0x7fffffff;
    };
    let objOk = 0;
    const meshes = 200;
    for (let mesh = 0; mesh < meshes; mesh++) {
        const vertexCount = 3 + Math.floor(next() * 40);
        const positions = Array.from({ length: vertexCount }, () => [0, 1, 2].map(() => Math.round((next() * 4 - 2) * 1000) / 1000));
        const lines = ['mtllib m.mtl'];
        positions.forEach(p => lines.push(`v ${p.join(' ')}`));
        const faces: { v: number[]; label: number; colour: number }[] = [];
        const colours = [rgbToHsl16(1, 0, 0), rgbToHsl16(0.2, 0.6, 0.3)];
        for (let f = 0; f < 1 + Math.floor(next() * 30); f++) {
            const label = Math.floor(next() * 5);
            const material = Math.floor(next() * 2);
            const corners = 3 + Math.floor(next() * 2);
            const v = Array.from({ length: corners }, () => Math.floor(next() * vertexCount));
            lines.push(`g label_${label}`, `usemtl m${material}`, `f ${v.map(i => i + 1).join(' ')}`);
            for (let k = 1; k + 1 < corners; k++) {
                faces.push({ v: [v[0], v[k], v[k + 1]], label, colour: colours[material] });
            }
        }
        const mtl = 'newmtl m0\nKd 1 0 0\nnewmtl m1\nKd 0.2 0.6 0.3\n';
        const scale = 50 + Math.floor(next() * 200);
        const model = decodeOb2(encodeOb2(convertObj(lines.join('\n'), 'fuzz.obj', { scale, readMtl: () => mtl }).model));
        let ok = model.faceA.length === faces.length;
        faces.forEach((face, f) => {
            const got = [model.faceA[f], model.faceB[f], model.faceC[f]];
            face.v.forEach((src, k) => {
                const p = positions[src];
                const want = [Math.round(p[0] * scale), Math.round(-p[1] * scale), Math.round(-p[2] * scale)];
                const v = got[k];
                ok &&= model.vertexX[v] === want[0] && model.vertexY[v] === want[1] && model.vertexZ[v] === want[2];
                ok &&= (model.vertexLabel ? model.vertexLabel[v] : 0) === face.label;
            });
            ok &&= model.faceColour[f] === face.colour;
        });
        if (ok) {
            objOk++;
        }
    }
    report(objOk === meshes, `${objOk}/${meshes} random OBJ meshes convert with exact positions, labels, colours and vertex order`);

    if (failures) {
        process.exitCode = 1;
    }
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
    case 'obj':
        objCommand(args);
        break;
    case 'model':
        modelCommand(args);
        break;
    case 'anim-unpack':
        animUnpackCommand(args);
        break;
    case 'anim-check':
        animCheckCommand(args);
        break;
    case 'anim-find':
        animFindCommand(args);
        break;
    case 'selftest':
        await selftestCommand();
        break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
        console.log(USAGE);
        break;
    default:
        console.error(kleur.red(`Unknown command '${command}'`));
        console.log(USAGE);
        process.exitCode = 1;
}
