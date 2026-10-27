// Checks for the anims fixture (bun run mod:fixture anims): animsets and
// frames from mods, overrides of base animations, an OBJ model, and the npc
// and seq configs that use them. Everything is decoded from the packed cache.
import fs from 'fs';
import path from 'path';

import AnimFrame from '#/cache/graphics/AnimFrame.js';
import Model from '#/cache/graphics/Model.js';
import SeqType from '#/cache/config/SeqType.js';
import Environment from '#/util/Environment.js';
import { rigLabels } from '#/mod/capabilities/objmodels.js';
import { AnimOp, AnimSetDef, decodeAnimSet, expandFrame, sameBase } from '#tools/pack/graphics/AnimSet.js';
import { decodeOb2, encodeOb2 } from '#tools/pack/graphics/Ob2.js';
import { convertObj, rgbToHsl16 } from '#tools/pack/graphics/ObjModel.js';
import { cacheCount, expect, getConfig, readBasePack, readCacheGunzip, readIdMap, sameBytes } from '#tools/mod/Inspect.js';

import { clientCheck, findClient } from './client-check.js';

const fixture = Environment.BUILD_MODS_DIR;
const ids = readIdMap(fixture);
const baseFrames = readBasePack('anim');
const baseSets = readBasePack('animset');
const frameId = (name: string): number => ids.frame?.[name] ?? baseFrames.get(name) ?? -1;

function cacheSet(id: number): AnimSetDef {
    const data = readCacheGunzip(2, id);
    expect(data, `cache archive 2 has file ${id}`);
    return decodeAnimSet(data);
}
function contentSet(name: string): AnimSetDef {
    return decodeAnimSet(new Uint8Array(fs.readFileSync(path.join(Environment.BUILD_SRC_DIR, 'models', `${name}.anim`))));
}
const frameOf = (set: AnimSetDef, name: string) => set.frames.find(f => f.id === frameId(name));
const t = (set: AnimSetDef, name: string) => frameOf(set, name)?.transforms.map(x => [x.group, x.x, x.y, x.z]);

// ---- ids: new names get stable ids after base content ----
for (const name of ['anims_critter', 'anims_rat_wave', 'anims_spin', 'anims_extra_set']) {
    expect(ids.animset?.[name] !== undefined && ids.animset[name] >= 264, `animset ${name} has an idmap id after the 264 base sets`);
}
for (const name of ['critter_ready_1', 'critter_ready_2', 'critter_walk_1', 'critter_walk_2', 'critter_walk_3', 'critter_walk_4', 'rat_wave_1', 'cow_moo_1', 'spin_1', 'spin_2', 'spin_3']) {
    expect(ids.frame?.[name] !== undefined && ids.frame[name] >= 8173, `frame ${name} has an idmap id after the 8173 base frames`);
}
expect(ids.frame?.anim_4178 === undefined && ids.frame?.anim_4389 === undefined, 'overridden base frames keep their base ids (no idmap entry)');
expect(cacheCount(2) >= 268, `cache archive 2 has the mod animsets (count ${cacheCount(2)})`);

// ---- every frame id is in exactly one animset file ----
const owner = new Map<number, number>();
const duplicates: string[] = [];
for (let file = 0; file < cacheCount(2); file++) {
    const data = readCacheGunzip(2, file);
    if (!data) {
        continue;
    }
    for (const frame of decodeAnimSet(data).frames) {
        if (owner.has(frame.id)) {
            duplicates.push(`${frame.id} (sets ${owner.get(frame.id)} and ${file})`);
        }
        owner.set(frame.id, file);
    }
}
expect(duplicates.length === 0 && owner.size === 8173 + 11, `every frame is in exactly one animset: ${owner.size} frames (duplicates: ${duplicates.slice(0, 5).join(', ') || 'none'})`);

// ---- the bone-form critter animset ----
const critter = cacheSet(ids.animset.anims_critter);
const groups = critter.base.types.map((type, i) => `${type}:${critter.base.labels[i].join(',')}`);
// children before parents; origin with no labels = absolute pivot; ops cover the bone and its descendants
const expectedGroups = ['0:', '2:2', '0:', '2:3', '0:', '3:4', '2:4', '0:', '2:5', '0:', '2:6', '0:', '2:7', '1:1,2,3,4,5,6,7'];
expect(groups.join(' ') === expectedGroups.join(' '), `critter base groups are ${expectedGroups.join(' ')} (got ${groups.join(' ')})`);
expect(critter.frames.map(f => f.id).join() === ['critter_ready_1', 'critter_ready_2', 'critter_walk_1', 'critter_walk_3', 'critter_walk_4'].map(frameId).join(), 'critter set holds its frames except critter_walk_2 (taken by anims_extra)');
expect(JSON.stringify(t(critter, 'critter_ready_1')) === '[]', 'critter_ready_1 is the rest pose');
expect(frameOf(critter, 'critter_ready_2')?.delay === 8 && frameOf(critter, 'critter_walk_1')?.delay === 5, 'frame delays: own value, else the file default');
// head yaw 90 degrees = 64 units; leg_fl scale [1, 1.5, 1] = [128, 192, 128]; body translate y -2
expect(
    JSON.stringify(t(critter, 'critter_walk_4')) ===
        JSON.stringify([
            [0, 0, -40, -26],
            [1, 0, 64, 0],
            [4, 12, -19, -18],
            [5, 128, 192, 128],
            [13, 0, -2, 0]
        ]),
    `critter_walk_4 transforms (got ${JSON.stringify(t(critter, 'critter_walk_4'))})`
);
// -10 degrees pitch = -7 units
expect(
    JSON.stringify(t(critter, 'critter_ready_2')) ===
        JSON.stringify([
            [0, 0, -40, -26],
            [1, -7, 0, 0],
            [2, 0, -38, 26],
            [3, 0, 11, 0]
        ]),
    `critter_ready_2 transforms (got ${JSON.stringify(t(critter, 'critter_ready_2'))})`
);

// ---- the server decodes every mod frame as the codec does ----
AnimFrame.load();
const serverMismatch: number[] = [];
let serverChecked = 0;
for (const id of [ids.animset.anims_critter, ids.animset.anims_rat_wave, ids.animset.anims_spin, ids.animset.anims_extra_set, 8, 13]) {
    const set = cacheSet(id);
    for (const frame of set.frames) {
        const server = AnimFrame.instances[frame.id];
        const expanded = expandFrame(set.base, frame);
        const same = server && server.delay === frame.delay && server.length === expanded.length && expanded.every((e, i) => server.groups[i] === e.group && server.x[i] === e.x && server.y[i] === e.y && server.z[i] === e.z);
        if (!same) {
            serverMismatch.push(frame.id);
        }
        serverChecked++;
    }
}
expect(serverMismatch.length === 0, `the server's AnimFrame decodes ${serverChecked} frames of the mod and changed sets like the codec (mismatches: ${serverMismatch.join(', ') || 'none'})`);

// ---- seq and npc configs use the mod frames by name ----
const walk = await getConfig('seq', 'anims_critter_walk');
expect(walk && Array.from(walk.frames as Int32Array).join() === ['critter_walk_1', 'critter_walk_2', 'critter_walk_3', 'critter_walk_4'].map(frameId).join(), 'seq anims_critter_walk points at the mod frame ids');
expect(walk && Array.from(walk.delay as Int32Array).join() === '5,4,5,5', `anims_critter_walk delays come from the frames (got ${walk && Array.from(walk.delay as Int32Array).join()})`);
const ratWave = await getConfig('seq', 'anims_rat_wave');
expect(ratWave && Array.from(ratWave.frames as Int32Array).join() === `${frameId('rat_wave_1')},4178` && Array.from(ratWave.delay as Int32Array).join() === '6,3', 'seq anims_rat_wave: mod frame, overridden base frame, seq delay wins');
const npc = await getConfig('npc', 'anims_critter');
const ready = await getConfig('seq', 'anims_critter_ready');
expect(npc && ready && walk && npc.readyanim === ready.id && npc.walkanim === walk.id, 'npc anims_critter uses the critter ready and walk seqs');
expect(npc && Array.from(npc.models as Int32Array | number[]).join() === String(ids.model.anims_critter), 'npc anims_critter uses the OBJ model');
// every seq (base and mod) only references frames that exist
SeqType.load('data/pack');
let checked = 0;
const missing: string[] = [];
for (let id = 0; id < SeqType.count; id++) {
    const seq = SeqType.get(id);
    for (const frame of seq.frames ?? []) {
        if (frame !== -1) {
            if (AnimFrame.instances[frame] === undefined) {
                missing.push(`${seq.debugname}:${frame}`);
            }
            checked++;
        }
    }
}
expect(checked > 8000 && missing.length === 0, `all ${checked} seq frame references (base and mod) exist (missing: ${missing.slice(0, 5).join(', ') || 'none'})`);

// ---- override of a base frame by name: anim_4178 moved out of base set anim_13 ----
const rat = cacheSet(13);
const ratContent = contentSet('anim_13');
expect(!frameOf(rat, 'anim_4178'), 'base set anim_13 no longer holds anim_4178');
expect(JSON.stringify(rat.frames) === JSON.stringify(ratContent.frames.filter(f => f.id !== 4178)) && sameBase(rat.base, ratContent.base), 'anim_13 keeps every other frame and its base unchanged');
const ratWaveSet = cacheSet(ids.animset.anims_rat_wave);
expect(sameBase(ratWaveSet.base, ratContent.base), 'anims_rat_wave uses the rat base (base_13)');
expect(JSON.stringify(t(ratWaveSet, 'anim_4178')) === '[[1,0,32,0],[3,0,-32,0],[11,0,-4,0]]' && frameOf(ratWaveSet, 'anim_4178')?.delay === 7, 'anim_4178 has the mod transforms');
expect(Array.from(((await getConfig('seq', 'rat_ready'))?.frames as Int32Array) ?? []).includes(4178), 'base seq rat_ready still uses frame 4178');

// ---- override of a base animset by name: anim_8 keeps what the mod does not redefine ----
const cow = cacheSet(8);
const cowContent = contentSet('anim_8');
expect(sameBase(cow.base, cowContent.base), 'anim_8 keeps its base');
expect(JSON.stringify(t(cow, 'anim_4389')) === '[[2,0,0,8]]' && frameOf(cow, 'anim_4389')?.delay === 9, 'anim_4389 has the mod transforms');
expect(JSON.stringify(t(cow, 'cow_moo_1')) === '[[4,24,0,0],[31,0,0,0]]' && frameOf(cow, 'cow_moo_1')?.delay === 12, 'new frame cow_moo_1 is in anim_8 (transforms sorted into group order)');
const changed = cowContent.frames.filter(f => f.id !== 4389 && JSON.stringify(frameOf(cow, `anim_${f.id}`)) !== JSON.stringify(f));
expect(changed.length === 0, `anim_8 keeps its other ${cowContent.frames.length - 1} base frames unchanged`);
expect(cow.frames.length === cowContent.frames.length + 1, 'anim_8 has the base frames plus cow_moo_1');

// ---- two mods: the later wins a frame name and a set name ----
const extra = cacheSet(ids.animset.anims_extra_set);
expect(sameBase(extra.base, critter.base), 'anims_extra_set reuses the critter base ("base": "anims_critter")');
expect(JSON.stringify(t(extra, 'critter_walk_2')) === '[[13,0,-6,0]]' && frameOf(extra, 'critter_walk_2')?.delay === 4, 'critter_walk_2 is anims_extra\'s ("body.translate" group name)');
const spin = cacheSet(ids.animset.anims_spin);
expect(JSON.stringify(spin.frames.map(f => f.transforms.find(x => spin.base.types[x.group] === AnimOp.ROTATE)?.y)) === '[0,85,-85]', "anims_spin is anims_extra's: 0, 120 and 240 degrees");

// ---- the OBJ model ----
const objPath = path.join(fixture, 'anims_base/models/anims_critter.obj');
const converted = convertObj(fs.readFileSync(objPath, 'utf-8'), 'anims_critter.obj', {
    labels: rigLabels(fs.readFileSync(path.join(fixture, 'anims_base/anims/anims_critter.json'), 'utf-8')),
    strictLabels: true,
    texture: name => (name === 'painting1' ? 13 : undefined),
    readMtl: name => fs.readFileSync(path.join(path.dirname(objPath), name), 'utf-8')
});
const packedModel = readCacheGunzip(1, ids.model.anims_critter);
expect(sameBytes(packedModel, encodeOb2(converted.model)), 'cache model anims_critter is the converted OBJ');
const model = decodeOb2(packedModel!);
Model.unpack(0, packedModel);
const engineModel = Model.fromId(0);
expect(engineModel.vertexCount === model.vertexX.length && engineModel.faceCount === 12 * 7, `model has ${engineModel.faceCount} faces (7 boxes, 2 triangles per side)`);
expect([...new Set(model.vertexLabel)].sort().join() === '1,2,3,4,5,6,7', 'vertex labels 1-7 come from the bone names');
// body: x -0.13..0.13, y 0.15..0.33 (up), z -0.2..0.2 (OBJ) -> x -17..17, y -42..-19, z -26..26 (model: y down, front -z)
const body = model.vertexLabel!.map((l, v) => (l === 1 ? v : -1)).filter(v => v >= 0);
const range = (arr: number[]) => [Math.min(...body.map(v => arr[v])), Math.max(...body.map(v => arr[v]))].join('..');
expect(range(model.vertexX) === '-17..17' && range(model.vertexY) === '-42..-19' && range(model.vertexZ) === '-26..26', `body box in model units (got x ${range(model.vertexX)}, y ${range(model.vertexY)}, z ${range(model.vertexZ)})`);
const head = model.vertexLabel!.map((l, v) => (l === 2 && model.vertexZ[v] < -40 ? v : -1)).filter(v => v >= 0);
expect(head.length > 0 && head.every(v => model.vertexZ[v] === -46), 'the head is at the front (-z)');
expect(model.faceColour[0] === rgbToHsl16(0.55, 0.35, 0.2), 'body faces have the fur colour');
const textured = model.faceInfo!.map((info, f) => ((info & 2) !== 0 ? f : -1)).filter(f => f >= 0);
expect(textured.length === 2 && textured.every(f => model.faceColour[f] === 13 && (model.faceInfo![f] & 3) === 3), 'two flat textured faces (head front) use texture 13 (painting1)');
expect(model.texP.length === 1, 'the head front quad shares one texture mapping');
const point = (v: number) => [model.vertexX[v], model.vertexY[v], model.vertexZ[v]].join(',');
// P = texel (0,0) = top-left of the image = OBJ uv (0,1) = (x0, y1); M = uv (1,1); N = uv (0,0)
expect(point(model.texP[0]) === '-12,-51,-46' && point(model.texM[0]) === '12,-51,-46' && point(model.texN[0]) === '-12,-28,-46', `texture axes P M N (got ${point(model.texP[0])} ${point(model.texM[0])} ${point(model.texN[0])})`);
// right-hand face normals point outward (as in base content)
let outward = 0;
for (let f = 0; f < model.faceA.length; f++) {
    const p = [model.faceA[f], model.faceB[f], model.faceC[f]].map(v => [model.vertexX[v], model.vertexY[v], model.vertexZ[v]]);
    const u = [0, 1, 2].map(i => p[1][i] - p[0][i]);
    const w = [0, 1, 2].map(i => p[2][i] - p[0][i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const label = model.vertexLabel![model.faceA[f]];
    const part = model.vertexLabel!.map((l, v) => (l === label ? v : -1)).filter(v => v >= 0);
    const centre = [model.vertexX, model.vertexY, model.vertexZ].map(arr => part.reduce((s, v) => s + arr[v], 0) / part.length);
    const fc = [0, 1, 2].map(i => (p[0][i] + p[1][i] + p[2][i]) / 3 - centre[i]);
    if (n[0] * fc[0] + n[1] * fc[1] + n[2] * fc[2] > 0) {
        outward++;
    }
}
expect(outward === model.faceA.length, `all faces wind outward (${outward}/${model.faceA.length})`);

// nothing leaked into the content dir
const leaked = ['anim', 'animset', 'base', 'model'].filter(type =>
    fs
        .readFileSync(path.join(Environment.BUILD_SRC_DIR, 'pack', `${type}.pack`), 'utf-8')
        .split('\n')
        .some(line => /=(critter_|spin_|rat_wave|cow_moo|anims_)/.test(line))
);
expect(leaked.length === 0, `no fixture names in content/pack (${leaked.join(', ') || 'none'})`);
expect(baseSets.size === 264 && baseFrames.size === 8173, 'base animset.pack and anim.pack are unchanged');

// ---- the same build through the web client's own loaders ----
const client = findClient();
if (client) {
    await clientCheck(client);
} else {
    console.log('skip - client loader checks: no client checkout (set CLIENT_DIR, or put Brumescape_Client-TS next to the engine)');
}
