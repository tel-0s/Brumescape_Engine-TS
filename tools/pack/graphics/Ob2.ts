// Codec for rev 245 models (.ob2, cache archive 1).
//
// Layout: data sections back to back, then an 18-byte footer:
//   g2 vertexCount, g2 faceCount, g1 texturedFaceCount, g1 hasInfo,
//   g1 priority (255: one priority per face, else the priority of every face),
//   g1 hasAlpha, g1 hasFaceLabels, g1 hasVertexLabels,
//   g2 vertex x data length, g2 y length, g2 z length, g2 face vertex data length
// Sections, in order:
//   vertex flags [vertexCount]  bit 0/1/2: a delta for x/y/z follows
//   face orientations [faceCount]  how the face's vertices are coded (1-4)
//   face priorities [faceCount]  (priority == 255)
//   face labels [faceCount]  (hasFaceLabels)
//   face info [faceCount]  (hasInfo) bits 0-1: 0 smooth, 1 flat, 2 textured
//                          smooth, 3 textured flat; bits 2+: textured face index
//   vertex labels [vertexCount]  (hasVertexLabels)
//   face alpha [faceCount]  (hasAlpha) 0 opaque .. 255
//   face vertices: signed smart deltas
//   face colours [faceCount] g2: HSL (6 bits hue, 3 saturation, 7 lightness),
//                          or a texture id for a textured face
//   texture axes [texturedFaceCount] g2 P, g2 M, g2 N: vertex indices
//   vertex x, y, z deltas: signed smarts
//
// Model space: x and z are horizontal, y points DOWN (negative y is up).
// 128 units are one tile.

import Packet from '#/io/Packet.js';
import { ByteWriter, smartsInRange } from '#tools/pack/graphics/Bytes.js';

export interface Ob2Model {
    vertexX: number[];
    vertexY: number[];
    vertexZ: number[];
    vertexLabel: number[] | null;
    faceA: number[];
    faceB: number[];
    faceC: number[];
    faceColour: number[];
    faceInfo: number[] | null;
    // per face, or null: then `priority` applies to every face
    facePriority: number[] | null;
    priority: number;
    faceAlpha: number[] | null;
    faceLabel: number[] | null;
    texP: number[];
    texM: number[];
    texN: number[];
}

export function decodeOb2(data: Uint8Array): Ob2Model {
    if (data.length < 18) {
        throw new Error(`model is too short (${data.length} bytes)`);
    }
    const footer = new Packet(data);
    footer.pos = data.length - 18;
    const vertexCount = footer.g2();
    const faceCount = footer.g2();
    const texturedFaceCount = footer.g1();
    const hasInfo = footer.g1() === 1;
    const priority = footer.g1();
    const hasAlpha = footer.g1() === 1;
    const hasFaceLabels = footer.g1() === 1;
    const hasVertexLabels = footer.g1() === 1;
    const lengthX = footer.g2();
    const lengthY = footer.g2();
    const lengthZ = footer.g2();
    const lengthFaceVertices = footer.g2();

    let pos = 0;
    const vertexFlagsOffset = pos;
    pos += vertexCount;
    const faceOrientationsOffset = pos;
    pos += faceCount;
    const facePrioritiesOffset = pos;
    if (priority === 255) pos += faceCount;
    const faceLabelsOffset = pos;
    if (hasFaceLabels) pos += faceCount;
    const faceInfosOffset = pos;
    if (hasInfo) pos += faceCount;
    const vertexLabelsOffset = pos;
    if (hasVertexLabels) pos += vertexCount;
    const faceAlphasOffset = pos;
    if (hasAlpha) pos += faceCount;
    const faceVerticesOffset = pos;
    pos += lengthFaceVertices;
    const faceColoursOffset = pos;
    pos += faceCount * 2;
    const textureAxisOffset = pos;
    pos += texturedFaceCount * 6;
    const vertexXOffset = pos;
    pos += lengthX;
    const vertexYOffset = pos;
    pos += lengthY;
    const vertexZOffset = pos;
    pos += lengthZ;
    if (pos !== data.length - 18) {
        throw new Error(`model section lengths (${pos}) do not match the data size (${data.length - 18})`);
    }

    const model: Ob2Model = {
        vertexX: [],
        vertexY: [],
        vertexZ: [],
        vertexLabel: hasVertexLabels ? [] : null,
        faceA: [],
        faceB: [],
        faceC: [],
        faceColour: [],
        faceInfo: hasInfo ? [] : null,
        facePriority: priority === 255 ? [] : null,
        priority: priority === 255 ? 0 : priority,
        faceAlpha: hasAlpha ? [] : null,
        faceLabel: hasFaceLabels ? [] : null,
        texP: [],
        texM: [],
        texN: []
    };

    const flags = new Packet(data);
    flags.pos = vertexFlagsOffset;
    const px = new Packet(data);
    px.pos = vertexXOffset;
    const py = new Packet(data);
    py.pos = vertexYOffset;
    const pz = new Packet(data);
    pz.pos = vertexZOffset;
    const vlabels = new Packet(data);
    vlabels.pos = vertexLabelsOffset;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let v = 0; v < vertexCount; v++) {
        const f = flags.g1();
        if (f & 0x1) x += px.gsmart();
        if (f & 0x2) y += py.gsmart();
        if (f & 0x4) z += pz.gsmart();
        model.vertexX.push(x);
        model.vertexY.push(y);
        model.vertexZ.push(z);
        if (model.vertexLabel) model.vertexLabel.push(vlabels.g1());
    }

    const colours = new Packet(data);
    colours.pos = faceColoursOffset;
    const infos = new Packet(data);
    infos.pos = faceInfosOffset;
    const priorities = new Packet(data);
    priorities.pos = facePrioritiesOffset;
    const alphas = new Packet(data);
    alphas.pos = faceAlphasOffset;
    const flabels = new Packet(data);
    flabels.pos = faceLabelsOffset;
    for (let f = 0; f < faceCount; f++) {
        model.faceColour.push(colours.g2());
        if (model.faceInfo) model.faceInfo.push(infos.g1());
        if (model.facePriority) model.facePriority.push(priorities.g1());
        if (model.faceAlpha) model.faceAlpha.push(alphas.g1());
        if (model.faceLabel) model.faceLabel.push(flabels.g1());
    }

    const verts = new Packet(data);
    verts.pos = faceVerticesOffset;
    const orients = new Packet(data);
    orients.pos = faceOrientationsOffset;
    let a = 0;
    let b = 0;
    let c = 0;
    let last = 0;
    for (let f = 0; f < faceCount; f++) {
        const orientation = orients.g1();
        if (orientation === 1) {
            a = verts.gsmart() + last;
            b = verts.gsmart() + a;
            c = verts.gsmart() + b;
            last = c;
        } else if (orientation === 2) {
            b = c;
            c = verts.gsmart() + last;
            last = c;
        } else if (orientation === 3) {
            a = c;
            c = verts.gsmart() + last;
            last = c;
        } else if (orientation === 4) {
            const tmp = a;
            a = b;
            b = tmp;
            c = verts.gsmart() + last;
            last = c;
        } else {
            throw new Error(`face ${f} has unknown orientation ${orientation}`);
        }
        model.faceA.push(a);
        model.faceB.push(b);
        model.faceC.push(c);
    }

    const axis = new Packet(data);
    axis.pos = textureAxisOffset;
    for (let t = 0; t < texturedFaceCount; t++) {
        model.texP.push(axis.g2());
        model.texM.push(axis.g2());
        model.texN.push(axis.g2());
    }

    return model;
}

export function validateOb2(model: Ob2Model): string[] {
    const errors: string[] = [];
    const vertexCount = model.vertexX.length;
    const faceCount = model.faceA.length;
    const texturedFaceCount = model.texP.length;
    if (vertexCount > 65535) errors.push(`${vertexCount} vertices (max 65535)`);
    if (faceCount > 65535) errors.push(`${faceCount} faces (max 65535)`);
    if (texturedFaceCount > 255) errors.push(`${texturedFaceCount} texture mappings (max 255)`);
    if (model.vertexY.length !== vertexCount || model.vertexZ.length !== vertexCount) errors.push('vertex arrays have different lengths');
    if (model.vertexLabel && model.vertexLabel.length !== vertexCount) errors.push('vertexLabel length differs from the vertex count');
    for (const [name, arr] of [
        ['faceB', model.faceB],
        ['faceC', model.faceC],
        ['faceColour', model.faceColour],
        ['faceInfo', model.faceInfo],
        ['facePriority', model.facePriority],
        ['faceAlpha', model.faceAlpha],
        ['faceLabel', model.faceLabel]
    ] as const) {
        if (arr && arr.length !== faceCount) errors.push(`${name} length differs from the face count`);
    }
    if (model.texM.length !== texturedFaceCount || model.texN.length !== texturedFaceCount) errors.push('texture axis arrays have different lengths');
    if (!(model.facePriority || (Number.isInteger(model.priority) && model.priority >= 0 && model.priority < 255))) errors.push(`priority ${model.priority} is out of range (0-254)`);

    let prev = [0, 0, 0];
    for (let v = 0; v < vertexCount; v++) {
        const cur = [model.vertexX[v], model.vertexY[v], model.vertexZ[v]];
        for (let i = 0; i < 3; i++) {
            if (!smartsInRange(cur[i] - prev[i])) {
                errors.push(`vertex ${v}: coordinate ${cur[i]} is too far from the previous vertex (deltas must be -16384..16383)`);
            }
        }
        prev = cur;
        if (model.vertexLabel && !byteInRange(model.vertexLabel[v])) errors.push(`vertex ${v}: label ${model.vertexLabel[v]} (0-255)`);
    }
    for (let f = 0; f < faceCount; f++) {
        for (const index of [model.faceA[f], model.faceB[f], model.faceC[f]]) {
            if (!Number.isInteger(index) || index < 0 || index >= vertexCount) errors.push(`face ${f}: vertex ${index} does not exist`);
        }
        if (!Number.isInteger(model.faceColour[f]) || model.faceColour[f] < 0 || model.faceColour[f] > 65535) errors.push(`face ${f}: colour ${model.faceColour[f]} (0-65535)`);
        if (model.faceInfo) {
            const info = model.faceInfo[f];
            if (!byteInRange(info)) {
                errors.push(`face ${f}: info ${info} (0-255)`);
            } else if ((info & 2) !== 0 && info >> 2 >= texturedFaceCount) {
                errors.push(`face ${f}: textured face index ${info >> 2} does not exist`);
            }
        }
        if (model.facePriority && !byteInRange(model.facePriority[f])) errors.push(`face ${f}: priority ${model.facePriority[f]} (0-255)`);
        if (model.faceAlpha && !byteInRange(model.faceAlpha[f])) errors.push(`face ${f}: alpha ${model.faceAlpha[f]} (0-255)`);
        if (model.faceLabel && !byteInRange(model.faceLabel[f])) errors.push(`face ${f}: label ${model.faceLabel[f]} (0-255)`);
    }
    for (let t = 0; t < texturedFaceCount; t++) {
        for (const index of [model.texP[t], model.texM[t], model.texN[t]]) {
            if (!Number.isInteger(index) || index < 0 || index >= vertexCount) errors.push(`texture mapping ${t}: vertex ${index} does not exist`);
        }
    }
    return errors;
}

function byteInRange(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 255;
}

export function encodeOb2(model: Ob2Model): Uint8Array {
    const errors = validateOb2(model);
    if (errors.length) {
        throw new Error(errors.slice(0, 5).join('; '));
    }

    const vertexCount = model.vertexX.length;
    const faceCount = model.faceA.length;

    const vertexFlags = new ByteWriter();
    const vx = new ByteWriter();
    const vy = new ByteWriter();
    const vz = new ByteWriter();
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let v = 0; v < vertexCount; v++) {
        const dx = model.vertexX[v] - px;
        const dy = model.vertexY[v] - py;
        const dz = model.vertexZ[v] - pz;
        let flags = 0;
        if (dx !== 0) {
            flags |= 0x1;
            vx.psmarts(dx);
        }
        if (dy !== 0) {
            flags |= 0x2;
            vy.psmarts(dy);
        }
        if (dz !== 0) {
            flags |= 0x4;
            vz.psmarts(dz);
        }
        vertexFlags.p1(flags);
        px = model.vertexX[v];
        py = model.vertexY[v];
        pz = model.vertexZ[v];
    }

    // Face vertices, coded as a strip where a face shares an edge with the
    // previous one (orientations 2-4), else as three deltas (orientation 1).
    const orientations = new ByteWriter();
    const faceVertices = new ByteWriter();
    let a = 0;
    let b = 0;
    let c = 0;
    let last = 0;
    for (let f = 0; f < faceCount; f++) {
        const fa = model.faceA[f];
        const fb = model.faceB[f];
        const fc = model.faceC[f];
        if (f > 0 && fa === a && fb === c) {
            orientations.p1(2);
        } else if (f > 0 && fa === c && fb === b) {
            orientations.p1(3);
        } else if (f > 0 && fa === b && fb === a) {
            orientations.p1(4);
        } else {
            orientations.p1(1);
            faceVertices.psmarts(fa - last);
            faceVertices.psmarts(fb - fa);
            faceVertices.psmarts(fc - fb);
            a = fa;
            b = fb;
            c = fc;
            last = fc;
            continue;
        }
        faceVertices.psmarts(fc - last);
        a = fa;
        b = fb;
        c = fc;
        last = fc;
    }

    const out = new ByteWriter();
    out.pdata(vertexFlags.toBytes());
    out.pdata(orientations.toBytes());
    if (model.facePriority) model.facePriority.forEach(p => out.p1(p));
    if (model.faceLabel) model.faceLabel.forEach(l => out.p1(l));
    if (model.faceInfo) model.faceInfo.forEach(i => out.p1(i));
    if (model.vertexLabel) model.vertexLabel.forEach(l => out.p1(l));
    if (model.faceAlpha) model.faceAlpha.forEach(al => out.p1(al));
    out.pdata(faceVertices.toBytes());
    model.faceColour.forEach(col => out.p2(col));
    for (let t = 0; t < model.texP.length; t++) {
        out.p2(model.texP[t]);
        out.p2(model.texM[t]);
        out.p2(model.texN[t]);
    }
    out.pdata(vx.toBytes());
    out.pdata(vy.toBytes());
    out.pdata(vz.toBytes());

    for (const length of [vx.length, vy.length, vz.length, faceVertices.length]) {
        if (length > 65535) {
            throw new Error(`model section is too large (${length} bytes, max 65535)`);
        }
    }

    out.p2(vertexCount);
    out.p2(faceCount);
    out.p1(model.texP.length);
    out.p1(model.faceInfo ? 1 : 0);
    out.p1(model.facePriority ? 255 : model.priority);
    out.p1(model.faceAlpha ? 1 : 0);
    out.p1(model.faceLabel ? 1 : 0);
    out.p1(model.vertexLabel ? 1 : 0);
    out.p2(vx.length);
    out.p2(vy.length);
    out.p2(vz.length);
    out.p2(faceVertices.length);
    return out.toBytes();
}
