// Codec for rev 245 animation sets (cache archive 2, content models/*.anim).
//
// One animset file holds one base (skeleton) and any number of frames. Frame
// ids are global: seq configs refer to frames by id, and the client and server
// both keep a single frame table indexed by id (AnimFrame.instances).
//
// File layout (all sections back to back, then an 8-byte footer):
//   head   g2 frameCount, then per frame: g2 frameId, g1 groupCount
//   tran1  per frame, per group < groupCount: g1 flags (bit 0: x, 1: y, 2: z)
//   tran2  per frame, per present component: signed smart value
//   del    per frame: g1 delay (client ticks of 20 ms)
//   base   g1 length, length x g1 type, then per group: g1 count, count x g1 label
//   footer g2 head length (without the 2-byte frame count), g2 tran1 length,
//          g2 tran2 length, g2 del length
//
// A frame "transform" is one active group of the base with its x, y, z
// values. Missing components take the default (128 for scale, else 0). When a
// frame activates a non-origin group, the decoders (client and server)
// implicitly apply the nearest preceding origin group that the frame does not
// activate itself, with offset 0,0,0. This codec keeps transforms as stored
// (explicit) and offers expandFrame() for the list the client really applies.

import Packet from '#/io/Packet.js';
import { ByteWriter, smartsInRange } from '#tools/pack/graphics/Bytes.js';

export const AnimOp = {
    ORIGIN: 0,
    TRANSLATE: 1,
    ROTATE: 2,
    SCALE: 3,
    ALPHA: 5
} as const;

export const ANIM_OP_NAMES: Record<number, string> = { 0: 'origin', 1: 'translate', 2: 'rotate', 3: 'scale', 5: 'alpha' };
export const ANIM_OP_BY_NAME: Record<string, number> = { origin: 0, translate: 1, rotate: 2, scale: 3, alpha: 5 };

export interface AnimBaseDef {
    types: number[];
    labels: number[][];
}

export interface AnimTransform {
    group: number;
    x: number;
    y: number;
    z: number;
}

export interface AnimFrameDef {
    id: number;
    delay: number;
    transforms: AnimTransform[];
}

export interface AnimSetDef {
    base: AnimBaseDef;
    frames: AnimFrameDef[];
}

export function defaultValue(type: number): number {
    return type === AnimOp.SCALE ? 128 : 0;
}

export function sameBase(a: AnimBaseDef, b: AnimBaseDef): boolean {
    if (a.types.length !== b.types.length) {
        return false;
    }
    for (let i = 0; i < a.types.length; i++) {
        if (a.types[i] !== b.types[i] || a.labels[i].length !== b.labels[i].length) {
            return false;
        }
        for (let j = 0; j < a.labels[i].length; j++) {
            if (a.labels[i][j] !== b.labels[i][j]) {
                return false;
            }
        }
    }
    return true;
}

// Frame ids only, without decoding transforms (cheap)
export function readAnimSetFrameIds(data: Uint8Array): number[] {
    const head = new Packet(data);
    const count = head.g2();
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
        ids.push(head.g2());
        head.g1();
    }
    return ids;
}

export function decodeAnimSet(data: Uint8Array): AnimSetDef {
    if (data.length < 11) {
        throw new Error(`animset is too short (${data.length} bytes)`);
    }

    const footer = new Packet(data);
    footer.pos = data.length - 8;
    const headLength = footer.g2();
    const tran1Length = footer.g2();
    const tran2Length = footer.g2();
    const delLength = footer.g2();

    let pos = 0;
    const head = new Packet(data);
    head.pos = pos;
    pos += headLength + 2;
    const tran1 = new Packet(data);
    tran1.pos = pos;
    pos += tran1Length;
    const tran2 = new Packet(data);
    tran2.pos = pos;
    pos += tran2Length;
    const del = new Packet(data);
    del.pos = pos;
    pos += delLength;
    if (pos > data.length - 8) {
        throw new Error('animset section lengths exceed the file size');
    }

    const baseBuf = new Packet(data);
    baseBuf.pos = pos;
    const length = baseBuf.g1();
    const types: number[] = [];
    for (let i = 0; i < length; i++) {
        types.push(baseBuf.g1());
    }
    const labels: number[][] = [];
    for (let i = 0; i < length; i++) {
        const count = baseBuf.g1();
        const group: number[] = [];
        for (let j = 0; j < count; j++) {
            group.push(baseBuf.g1());
        }
        labels.push(group);
    }
    if (baseBuf.pos > data.length - 8) {
        throw new Error('animset base runs into the footer');
    }
    const base: AnimBaseDef = { types, labels };

    const frames: AnimFrameDef[] = [];
    const total = head.g2();
    for (let i = 0; i < total; i++) {
        const id = head.g2();
        const groupCount = head.g1();
        const delay = del.g1();
        const transforms: AnimTransform[] = [];
        for (let group = 0; group < groupCount; group++) {
            const flags = tran1.g1();
            if (flags === 0) {
                continue;
            }
            if (group >= length) {
                throw new Error(`frame ${id} uses group ${group}, but the base has ${length} groups`);
            }
            const def = defaultValue(types[group]);
            const x = flags & 0x1 ? tran2.gsmart() : def;
            const y = flags & 0x2 ? tran2.gsmart() : def;
            const z = flags & 0x4 ? tran2.gsmart() : def;
            transforms.push({ group, x, y, z });
        }
        frames.push({ id, delay, transforms });
    }

    if (head.pos !== headLength + 2 || tran1.pos !== headLength + 2 + tran1Length || tran2.pos !== headLength + 2 + tran1Length + tran2Length) {
        throw new Error('animset section lengths do not match the frame data');
    }

    return { base, frames };
}

// Checks everything the encoder and the cache format need. Returns messages.
export function validateAnimSet(set: AnimSetDef): string[] {
    const errors: string[] = [];
    const { base } = set;
    if (base.types.length > 255) {
        errors.push(`the base has ${base.types.length} groups (max 255)`);
    }
    if (base.labels.length !== base.types.length) {
        errors.push('base types and labels have different lengths');
    }
    for (let i = 0; i < base.types.length; i++) {
        if (ANIM_OP_NAMES[base.types[i]] === undefined) {
            errors.push(`base group ${i} has unknown type ${base.types[i]} (origin=0, translate=1, rotate=2, scale=3, alpha=5)`);
        }
        const labels = base.labels[i] ?? [];
        if (labels.length > 255) {
            errors.push(`base group ${i} has ${labels.length} labels (max 255)`);
        }
        for (const label of labels) {
            if (!Number.isInteger(label) || label < 0 || label > 255) {
                errors.push(`base group ${i} has label ${label} (labels are 0-255)`);
            }
        }
    }
    if (set.frames.length > 65535) {
        errors.push(`${set.frames.length} frames in one animset (max 65535)`);
    }
    for (const frame of set.frames) {
        if (!Number.isInteger(frame.id) || frame.id < 0 || frame.id > 65534) {
            errors.push(`frame id ${frame.id} is out of range (0-65534)`);
        }
        if (!Number.isInteger(frame.delay) || frame.delay < 0 || frame.delay > 255) {
            errors.push(`frame ${frame.id}: delay ${frame.delay} is out of range (0-255)`);
        }
        let last = -1;
        for (const t of frame.transforms) {
            if (!Number.isInteger(t.group) || t.group < 0 || t.group >= base.types.length) {
                errors.push(`frame ${frame.id}: group ${t.group} does not exist (the base has ${base.types.length} groups)`);
                continue;
            }
            if (t.group <= last) {
                errors.push(`frame ${frame.id}: groups must be in increasing order without repeats (group ${t.group} after ${last})`);
            }
            last = t.group;
            for (const v of [t.x, t.y, t.z]) {
                if (!smartsInRange(v)) {
                    errors.push(`frame ${frame.id}: group ${t.group} value ${v} is out of range (whole numbers -16384..16383)`);
                }
            }
        }
    }
    return errors;
}

export function encodeAnimSet(set: AnimSetDef): Uint8Array {
    const errors = validateAnimSet(set);
    if (errors.length) {
        throw new Error(errors[0]);
    }

    const { base } = set;
    const head = new ByteWriter();
    const tran1 = new ByteWriter();
    const tran2 = new ByteWriter();
    const del = new ByteWriter();

    head.p2(set.frames.length);
    for (const frame of set.frames) {
        const groupCount = frame.transforms.length ? frame.transforms[frame.transforms.length - 1].group + 1 : 0;
        head.p2(frame.id);
        head.p1(groupCount);
        del.p1(frame.delay);

        let next = 0;
        for (const t of frame.transforms) {
            for (; next < t.group; next++) {
                tran1.p1(0);
            }
            next = t.group + 1;

            const def = defaultValue(base.types[t.group]);
            let flags = 0;
            if (t.x !== def) flags |= 0x1;
            if (t.y !== def) flags |= 0x2;
            if (t.z !== def) flags |= 0x4;
            if (flags === 0) {
                // all defaults: still active (e.g. an explicit origin at 0,0,0)
                flags = 0x1;
            }
            tran1.p1(flags);
            if (flags & 0x1) tran2.psmarts(t.x);
            if (flags & 0x2) tran2.psmarts(t.y);
            if (flags & 0x4) tran2.psmarts(t.z);
        }
    }

    const baseOut = new ByteWriter();
    baseOut.p1(base.types.length);
    for (const type of base.types) {
        baseOut.p1(type);
    }
    for (const labels of base.labels) {
        baseOut.p1(labels.length);
        for (const label of labels) {
            baseOut.p1(label);
        }
    }

    const out = new ByteWriter();
    out.pdata(head.toBytes());
    out.pdata(tran1.toBytes());
    out.pdata(tran2.toBytes());
    out.pdata(del.toBytes());
    out.pdata(baseOut.toBytes());
    const headLength = head.length - 2;
    for (const length of [headLength, tran1.length, tran2.length, del.length]) {
        if (length > 65535) {
            throw new Error(`animset section is too large (${length} bytes, max 65535)`);
        }
    }
    out.p2(headLength);
    out.p2(tran1.length);
    out.p2(tran2.length);
    out.p2(del.length);
    return out.toBytes();
}

// The transforms the client applies for a frame, in order: the stored ones
// plus the implicit origins the decoder inserts (see the header comment).
// Mirrors AnimFrame.unpack in the client and server.
export function expandFrame(base: AnimBaseDef, frame: AnimFrameDef): AnimTransform[] {
    const out: AnimTransform[] = [];
    let lastGroup = -1;
    for (const t of frame.transforms) {
        if (base.types[t.group] !== AnimOp.ORIGIN) {
            for (let group = t.group - 1; group > lastGroup; group--) {
                if (base.types[group] === AnimOp.ORIGIN) {
                    out.push({ group, x: 0, y: 0, z: 0 });
                    break;
                }
            }
        }
        out.push({ group: t.group, x: t.x, y: t.y, z: t.z });
        lastGroup = t.group;
    }
    return out;
}
