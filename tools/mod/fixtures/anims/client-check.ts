// Decodes the anims fixture build with the web client's own loaders
// (Brumescape_Client-TS: AnimFrame, AnimBase, SeqType, Model, Pix3D) and
// animates the critter model with them.
//
// check.ts runs this when it finds a client checkout: CLIENT_DIR, or
// ../Brumescape_Client-TS next to the engine. Standalone, after a build of the
// anims fixture:
//   CLIENT_DIR=<client checkout> BUILD_MODS_DIR=tools/mod/fixtures/anims bun run tools/mod/fixtures/anims/client-check.ts
import fs from 'fs';
import path from 'path';

import FileStream from '#/io/FileStream.js';
import Environment from '#/util/Environment.js';
import { AnimSetDef, decodeAnimSet, expandFrame } from '#tools/pack/graphics/AnimSet.js';
import { decodeOb2 } from '#tools/pack/graphics/Ob2.js';
import { cacheCount, expect, readBasePack, readIdMap, readJagEntry } from '#tools/mod/Inspect.js';

export function findClient(): string | null {
    const dir = path.resolve(process.env.CLIENT_DIR ?? '../Brumescape_Client-TS');
    return fs.existsSync(path.join(dir, 'src/dash3d/Model.ts')) ? dir : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function clientCheck(clientDir: string) {
    // The client's Jagfile and OnDemand import its bundled deps (audio, midi),
    // which need a browser. Archive 0 entries are read with the engine's
    // Jagfile instead, and the versionlist is parsed like OnDemand's
    // constructor does.
    const load = async (file: string) => (await import(path.join(clientDir, 'src', file))).default as any;
    const Model = await load('dash3d/Model.ts');
    const AnimFrame = await load('dash3d/AnimFrame.ts');
    const SeqType = await load('config/SeqType.ts');
    const Pix3D = await load('graphics/Pix3D.ts');

    const ids = readIdMap(Environment.BUILD_MODS_DIR);
    const baseFrames = readBasePack('anim');
    const frameId = (name: string): number => ids.frame?.[name] ?? baseFrames.get(name) ?? -1;
    const cache = new FileStream('data/pack', false, true);
    const gunzip = (data: Uint8Array) => new Uint8Array(Bun.gunzipSync(data));
    const jagEntry = (file: number, name: string): Uint8Array => readJagEntry(file, name)!;

    // versionlist (OnDemand constructor): anim_version has a g2 per animset
    // file, anim_index a g2 per frame (only its length is used: AnimFrame.init)
    const animVersion = jagEntry(5, 'anim_version');
    const animsets = animVersion.length / 2;
    const version = (file: number) => (animVersion[file * 2] << 8) | animVersion[file * 2 + 1];
    const animCount = jagEntry(5, 'anim_index').length / 2;
    expect(animsets === cacheCount(2), `client versionlist: ${animsets} animset files (cache has ${cacheCount(2)})`);
    expect(version(ids.animset.anims_critter) === 1 && version(ids.animset.anims_extra_set) === 1, 'client versionlist: the mod animsets have a version, so the client requests them');
    const highest = Math.max(...Object.values(ids.frame ?? {}));
    expect(animCount > highest, `client versionlist: anim_index covers frame id ${highest} (AnimFrame.init(${animCount}))`);

    // every animset, as the client unpacks them at startup ("Loading animations"),
    // and every frame (base and mod) as the engine's codec reads it
    AnimFrame.init(animCount);
    const sets: AnimSetDef[] = [];
    for (let file = 0; file < animsets; file++) {
        const data = cache.read(2, file);
        if (data) {
            AnimFrame.unpack(gunzip(data));
            sets.push(decodeAnimSet(gunzip(data)));
        }
    }
    let frames = 0;
    const frameMismatch: number[] = [];
    for (const set of sets) {
        for (const frame of set.frames) {
            const client = AnimFrame.get(frame.id);
            const expanded = expandFrame(set.base, frame);
            const same = client && client.delay === frame.delay && client.length === expanded.length && expanded.every((e, i) => client.groups[i] === e.group && client.x[i] === e.x && client.y[i] === e.y && client.z[i] === e.z);
            const base = client?.base;
            const sameSkeleton = base && base.length === set.base.types.length && set.base.types.every((type, i) => base.types[i] === type && Array.from(base.labels[i] as Uint8Array).join() === set.base.labels[i].join());
            if (!same || !sameSkeleton) {
                frameMismatch.push(frame.id);
            }
            frames++;
        }
    }
    expect(frameMismatch.length === 0, `client AnimFrame/AnimBase: all ${frames} frames in the cache decode as the codec wrote them (mismatches: ${frameMismatch.slice(0, 5).join(', ') || 'none'})`);

    // seq configs
    SeqType.unpack({ read: (name: string) => jagEntry(2, name) });
    const seqId = (name: string) => readBasePack('seq').get(name) ?? ids.seq?.[name] ?? -1;
    const walk = SeqType.types[seqId('anims_critter_walk')];
    expect(walk && Array.from(walk.frames as Int16Array | Int32Array).join() === ['critter_walk_1', 'critter_walk_2', 'critter_walk_3', 'critter_walk_4'].map(frameId).join(), 'client SeqType: anims_critter_walk has the mod frame ids');
    expect([0, 1, 2, 3].map(i => walk.getFrameDuration(i)).join() === '5,4,5,5', 'client SeqType: frame durations come from the mod frames (5,4,5,5)');
    const ratReady = SeqType.types[seqId('rat_ready')];
    expect(AnimFrame.get(ratReady.frames[0])?.delay === 7, "client: base seq rat_ready frame 1 (anim_4178) is the mod's override (delay 7)");

    // every model in the cache (base and mod) as the client decodes it
    Model.init(cacheCount(1), { requestModel() {} });
    let models = 0;
    const modelMismatch: number[] = [];
    for (let id = 0; id < cacheCount(1); id++) {
        const data = cache.read(1, id);
        if (!data) {
            continue;
        }
        Model.unpack(id, gunzip(data));
        const client = Model.fromId(id);
        const codec = decodeOb2(gunzip(data));
        const same = (a: ArrayLike<number> | null | undefined, b: number[] | null) => ((a ?? null) === null ? b === null : b !== null && a!.length === b.length && b.every((x, i) => a![i] === x));
        const ok =
            same(client.vertexX, codec.vertexX) &&
            same(client.vertexY, codec.vertexY) &&
            same(client.vertexZ, codec.vertexZ) &&
            same(client.vertexLabel, codec.vertexLabel) &&
            same(client.faceVertexA, codec.faceA) &&
            same(client.faceVertexB, codec.faceB) &&
            same(client.faceVertexC, codec.faceC) &&
            same(client.faceColour, codec.faceColour) &&
            same(client.faceInfo, codec.faceInfo) &&
            same(client.facePriority, codec.facePriority) &&
            same(client.faceAlpha, codec.faceAlpha) &&
            same(client.faceLabel, codec.faceLabel) &&
            same(client.texturedVertexA, codec.texP) &&
            same(client.texturedVertexB, codec.texM) &&
            same(client.texturedVertexC, codec.texN);
        if (!ok) {
            modelMismatch.push(id);
        }
        models++;
    }
    expect(modelMismatch.length === 0, `client Model: all ${models} models in the cache decode as the codec reads them (mismatches: ${modelMismatch.slice(0, 5).join(', ') || 'none'})`);

    // the critter model, animated by the client
    const modelId = ids.model.anims_critter;
    const rest = Model.fromId(modelId);
    expect(rest.vertexCount > 0 && rest.vertexLabel, 'client Model: the critter decodes with vertex labels');

    const posed = (frame: string) => {
        const model = Model.fromId(modelId);
        model.createLabelReferences();
        model.applyTransform(frameId(frame));
        return model;
    };
    const restX: number[] = Array.from(rest.vertexX);
    const restY: number[] = Array.from(rest.vertexY);
    const restZ: number[] = Array.from(rest.vertexZ);
    const labels: number[] = Array.from(rest.vertexLabel);

    // expected positions from the bone definitions, with float math
    const rotateY = (p: number[], pivot: number[], degrees: number) => {
        const a = (degrees * Math.PI) / 180;
        const dx = p[0] - pivot[0];
        const dz = p[2] - pivot[2];
        // the client's yaw: x' = z sin + x cos, z' = z cos - x sin
        return [pivot[0] + dz * Math.sin(a) + dx * Math.cos(a), p[1], pivot[2] + dz * Math.cos(a) - dx * Math.sin(a)];
    };
    const rotateX = (p: number[], pivot: number[], degrees: number) => {
        const a = (degrees * Math.PI) / 180;
        const dy = p[1] - pivot[1];
        const dz = p[2] - pivot[2];
        // the client's pitch: y' = y cos - z sin, z' = y sin + z cos
        return [p[0], pivot[1] + dy * Math.cos(a) - dz * Math.sin(a), pivot[2] + dy * Math.sin(a) + dz * Math.cos(a)];
    };
    const compare = (frame: string, expectedOf: (p: number[], label: number) => number[]) => {
        const model = posed(frame);
        let worst = 0;
        for (let v = 0; v < rest.vertexCount; v++) {
            const want = expectedOf([restX[v], restY[v], restZ[v]], labels[v]);
            worst = Math.max(worst, Math.abs(model.vertexX[v] - want[0]), Math.abs(model.vertexY[v] - want[1]), Math.abs(model.vertexZ[v] - want[2]));
        }
        expect(worst <= 2, `client Model.applyTransform(${frame}): every vertex within 2 units of the bone math (worst ${worst.toFixed(2)})`);
    };

    compare('critter_ready_1', p => p);
    // 90 degrees = 64 units exactly; head turns about the neck, legs scale, then the whole body moves up 2
    compare('critter_walk_4', (p, label) => {
        let q = p;
        if (label === 2) {
            q = rotateY(q, [0, -40, -26], 90);
        }
        if (label === 4) {
            q = [q[0], -19 + ((q[1] + 19) * 192) / 128, q[2]];
        }
        return [q[0], q[1] - 2, q[2]];
    });
    // legs swing 25 degrees (18 units = 25.3 degrees) about their hips, tail turns 20 degrees (14 units = 19.7)
    const hips: Record<number, number[]> = { 4: [12, -19, -18], 5: [-12, -19, -18], 6: [12, -19, 18], 7: [-12, -19, 18] };
    const swing: Record<number, number> = { 4: 18, 5: -18, 6: -18, 7: 18 };
    compare('critter_walk_1', (p, label) => {
        if (hips[label]) {
            return rotateX(p, hips[label], (swing[label] * 360) / 256);
        }
        if (label === 3) {
            return rotateY(p, [0, -38, 26], (14 * 360) / 256);
        }
        return p;
    });
    // anims_extra's critter_walk_2: body.translate y -6 (all labels)
    compare('critter_walk_2', p => [p[0], p[1] - 6, p[2]]);
    const turned = posed('critter_walk_4');
    const nose = rest.texturedVertexA[0];
    expect(turned.vertexX[nose] === -20 && turned.vertexZ[nose] === -14, `client: in critter_walk_4 the head turned to the critter's right, front corner (-12,-51,-46) -> (${turned.vertexX[nose]},${turned.vertexY[nose]},${turned.vertexZ[nose]})`);

    // texture axes, with the client's texture mapping (Pix3D.textureTriangle):
    // texel column = u / w, row = v / w for a view-space point X
    const view = (v: number) => [rest.vertexX[v], rest.vertexY[v], rest.vertexZ[v] + 600];
    const [P, M, N] = [rest.texturedVertexA[0], rest.texturedVertexB[0], rest.texturedVertexC[0]].map(view);
    const vertical = [P[0] - M[0], P[1] - M[1], P[2] - M[2]];
    const horizontal = [N[0] - P[0], N[1] - P[1], N[2] - P[2]];
    const texel = (X: number[]) => {
        const u = (horizontal[1] * P[2] - horizontal[2] * P[1]) * X[0] + (horizontal[2] * P[0] - horizontal[0] * P[2]) * X[1] + (horizontal[0] * P[1] - horizontal[1] * P[0]) * X[2];
        const v = (vertical[1] * P[2] - vertical[2] * P[1]) * X[0] + (vertical[2] * P[0] - vertical[0] * P[2]) * X[1] + (vertical[0] * P[1] - vertical[1] * P[0]) * X[2];
        const w = (vertical[2] * horizontal[1] - vertical[1] * horizontal[2]) * X[0] + (vertical[0] * horizontal[2] - vertical[2] * horizontal[0]) * X[1] + (vertical[1] * horizontal[0] - vertical[0] * horizontal[1]) * X[2];
        return [u / w, v / w].map(n => Math.round(n * 100) / 100 + 0);
    };
    // head front corners: OBJ uv (0,1) top-left, (1,1) top-right, (0,0) bottom-left, (1,0) bottom-right
    const corner = (x: number, y: number) => texel([x, y, -46 + 600]);
    const got = [corner(-12, -51), corner(12, -51), corner(-12, -28), corner(12, -28)].map(c => c.join(',')).join(' ');
    expect(got === '0,0 1,0 0,1 1,1', `client texture mapping: head front corners map to texels (col,row) 0,0 1,0 0,1 1,1, the image upright (got ${got})`);

    // colours: the client's colour table turns the fur HSL back into roughly the OBJ colour
    Pix3D.initColourTable(1.0);
    const rgb = Pix3D.colourTable[rest.faceColour[0]];
    const channels = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
    const want = [0.55, 0.35, 0.2].map(c => c * 256);
    expect(
        channels.every((c, i) => Math.abs(c - want[i]) <= 16),
        `client colour table: fur hsl ${rest.faceColour[0]} renders as rgb(${channels}) for Kd 0.55 0.35 0.20`
    );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

if (import.meta.main) {
    const dir = findClient();
    if (!dir) {
        throw new Error('No client checkout: set CLIENT_DIR');
    }
    await clientCheck(dir);
}
