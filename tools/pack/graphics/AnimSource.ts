// Text sources for animation sets (mods' anims/**/<set>.json).
//
// Two forms, told apart by their keys:
//
// 1. Base form ("base" + "frames"): the cache data as JSON. A base is a list
//    of groups (origin/translate/rotate/scale/alpha + vertex labels), and a
//    frame lists [group, x, y, z] transforms. `bun run mod:art anim-unpack`
//    writes base content in this form, so it is also the way to edit and
//    override base animations.
//
// 2. Bone form ("bones" + "frames"): bones own vertex labels and have a
//    parent and a pivot; a frame gives each bone a rotate (degrees),
//    translate and scale. It is compiled into a base and base-form frames:
//    per bone (children before parents) origin, scale, rotate, translate
//    groups over the labels of the bone and all its descendants.
//
// See the mod author docs (anims) for the full format.

import { ANIM_OP_BY_NAME, ANIM_OP_NAMES, AnimBaseDef, AnimOp, AnimTransform, defaultValue } from '#tools/pack/graphics/AnimSet.js';
import { JsonSyntaxError, parseJsonWithLines } from '#tools/pack/graphics/JsonLines.js';

export class AnimSourceError extends Error {
    readonly line: number | null;

    constructor(message: string, line: number | null) {
        super(message);
        this.line = line;
    }
}

export const NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export interface SourceTransform {
    group: number | string;
    // x, y, z as written; undefined means the default of the group's type
    values: (number | undefined)[];
    line: number | null;
}

export interface SourceFrame {
    name: string;
    delay: number;
    transforms: SourceTransform[];
    line: number | null;
}

export interface RigBone {
    name: string;
    labels: number[];
    parent: string | null;
    pivot: [number, number, number] | null;
    line: number | null;
}

export interface AnimSetSource {
    form: 'base' | 'bones';
    // inline base (base form with groups, or compiled bones), or null with baseRef
    base: AnimBaseDef | null;
    baseRef: string | null;
    baseLine: number | null;
    // group name -> index for an inline base
    groupNames: Map<string, number>;
    frames: SourceFrame[];
    // bone form only
    bones: RigBone[] | null;
}

export interface ResolvedFrame {
    name: string;
    delay: number;
    transforms: AnimTransform[];
    line: number | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAnimSetSource(text: string): AnimSetSource {
    let doc;
    try {
        doc = parseJsonWithLines(text);
    } catch (err) {
        if (err instanceof JsonSyntaxError) {
            throw new AnimSourceError(`invalid JSON: ${err.message}`, err.line);
        }
        throw err;
    }
    const lineOf = (value: unknown): number | null => (typeof value === 'object' && value !== null ? (doc.lines.get(value) ?? null) : null);
    const fail = (message: string, at: unknown): never => {
        throw new AnimSourceError(message, lineOf(at));
    };

    if (!isObject(doc.value)) {
        throw new AnimSourceError('the file must contain one JSON object', 1);
    }
    const root: Json = doc.value;

    function checkKeys(obj: Json, allowed: string[], what: string) {
        for (const key of Object.keys(obj)) {
            if (key !== 'comment' && !allowed.includes(key)) {
                fail(`unknown key "${key}" in ${what} (allowed: ${allowed.join(', ')}, comment)`, obj);
            }
        }
    }

    function integer(value: unknown, what: string, at: unknown, min: number, max: number): number {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            fail(`${what} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`, at);
        }
        return value as number;
    }

    function numberTriple(value: unknown, what: string, at: unknown): [number, number, number] {
        if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
            fail(`${what} must be [x, y, z] numbers (got ${JSON.stringify(value)})`, at);
        }
        return value as [number, number, number];
    }

    const hasBones = 'bones' in root;
    const hasBase = 'base' in root;
    if (hasBones && hasBase) {
        fail('use either "bones" (bone form) or "base" (base form), not both', root);
    }
    if (!Array.isArray(root.frames)) {
        fail('"frames" must be an array of frames', root);
    }
    let defaultDelay: number | null = null;
    if (root.delay !== undefined) {
        defaultDelay = integer(root.delay, '"delay"', root, 0, 255);
    }

    const frameNames = new Set<string>();
    function frameHeader(frame: unknown, index: number, keys: string[]): { obj: Json; name: string; delay: number } {
        if (!isObject(frame)) {
            fail(`frames[${index}] must be an object`, root.frames);
        }
        const obj = frame as Json;
        checkKeys(obj, keys, `frames[${index}]`);
        if (typeof obj.name !== 'string' || !NAME_PATTERN.test(obj.name)) {
            fail(`frames[${index}] needs a "name" made of letters, digits and _ (got ${JSON.stringify(obj.name)})`, obj);
        }
        const name = obj.name as string;
        if (frameNames.has(name)) {
            fail(`frame "${name}" is defined twice in this file`, obj);
        }
        frameNames.add(name);
        let delay: number;
        if (obj.delay !== undefined) {
            delay = integer(obj.delay, `frame "${name}" delay`, obj, 0, 255);
        } else if (defaultDelay !== null) {
            delay = defaultDelay;
        } else {
            fail(`frame "${name}" needs a "delay" (client ticks of 20 ms), or set a top-level "delay"`, obj);
        }
        return { obj, name, delay: delay! };
    }

    if (!hasBones) {
        // ---- base form ----
        checkKeys(root, ['base', 'frames', 'delay'], 'the animset');
        let base: AnimBaseDef | null = null;
        let baseRef: string | null = null;
        const groupNames = new Map<string, number>();
        if (typeof root.base === 'string') {
            baseRef = root.base;
        } else if (isObject(root.base)) {
            checkKeys(root.base, ['groups'], '"base"');
            if (!Array.isArray(root.base.groups)) {
                fail('"base" needs "groups": an array of { "type", "labels" }', root.base);
            }
            const groups = root.base.groups as unknown[];
            if (groups.length > 255) {
                fail(`the base has ${groups.length} groups (max 255)`, groups);
            }
            base = { types: [], labels: [] };
            groups.forEach((group, i) => {
                if (!isObject(group)) {
                    fail(`base group ${i} must be an object`, groups);
                }
                const g = group as Json;
                checkKeys(g, ['type', 'labels', 'name'], `base group ${i}`);
                const type = typeof g.type === 'string' ? ANIM_OP_BY_NAME[g.type] : undefined;
                if (type === undefined) {
                    fail(`base group ${i} "type" must be one of ${Object.keys(ANIM_OP_BY_NAME).join(', ')} (got ${JSON.stringify(g.type)})`, g);
                }
                if (!Array.isArray(g.labels)) {
                    fail(`base group ${i} needs "labels": an array of vertex labels (face labels for alpha)`, g);
                }
                const labels = (g.labels as unknown[]).map(l => integer(l, `base group ${i} label`, g, 0, 255));
                if (labels.length > 255) {
                    fail(`base group ${i} has ${labels.length} labels (max 255)`, g);
                }
                if (g.name !== undefined) {
                    if (typeof g.name !== 'string' || !g.name.length || /^[0-9]+$/.test(g.name)) {
                        fail(`base group ${i} "name" must be a non-numeric string`, g);
                    }
                    if (groupNames.has(g.name as string)) {
                        fail(`base group name "${g.name}" is used twice`, g);
                    }
                    groupNames.set(g.name as string, i);
                }
                base!.types.push(type!);
                base!.labels.push(labels);
            });
        } else if (root.base !== undefined) {
            fail('"base" must be the name of an existing base or animset, or { "groups": [...] }', root);
        }

        const frames: SourceFrame[] = (root.frames as unknown[]).map((frame, index) => {
            const { obj, name, delay } = frameHeader(frame, index, ['name', 'delay', 'transforms']);
            const list = obj.transforms ?? [];
            if (!Array.isArray(list)) {
                fail(`frame "${name}" "transforms" must be an array of [group, x, y, z]`, obj);
            }
            const transforms: SourceTransform[] = (list as unknown[]).map(entry => {
                if (!Array.isArray(entry) || entry.length < 1 || entry.length > 4) {
                    fail(`frame "${name}": each transform is [group, x, y, z] (y and z optional) (got ${JSON.stringify(entry)})`, list);
                }
                const [group, ...values] = entry as unknown[];
                if (!(typeof group === 'string' || (typeof group === 'number' && Number.isInteger(group) && group >= 0))) {
                    fail(`frame "${name}": a transform's group must be a group index or name (got ${JSON.stringify(group)})`, entry);
                }
                for (const v of values) {
                    if (typeof v !== 'number' || !Number.isInteger(v) || v < -16384 || v > 16383) {
                        fail(`frame "${name}": transform values must be whole numbers from -16384 to 16383 (got ${JSON.stringify(v)})`, entry);
                    }
                }
                return { group: group as number | string, values: values as number[], line: lineOf(entry) };
            });
            return { name, delay, transforms, line: lineOf(obj) };
        });

        return { form: 'base', base, baseRef, baseLine: lineOf(root), groupNames, frames, bones: null };
    }

    // ---- bone form ----
    checkKeys(root, ['bones', 'frames', 'delay'], 'the animset');
    if (!Array.isArray(root.bones) || !root.bones.length) {
        fail('"bones" must be a non-empty array of { "name", "label" or "labels", "parent", "pivot" }', root);
    }
    const bones: RigBone[] = [];
    const byName = new Map<string, RigBone>();
    const labelOwner = new Map<number, string>();
    for (const [i, entry] of (root.bones as unknown[]).entries()) {
        if (!isObject(entry)) {
            fail(`bones[${i}] must be an object`, root.bones);
        }
        const b = entry as Json;
        checkKeys(b, ['name', 'label', 'labels', 'parent', 'pivot'], `bones[${i}]`);
        if (typeof b.name !== 'string' || !NAME_PATTERN.test(b.name)) {
            fail(`bones[${i}] needs a "name" made of letters, digits and _`, b);
        }
        const name = b.name as string;
        if (byName.has(name)) {
            fail(`bone "${name}" is defined twice`, b);
        }
        let labels: number[];
        if (b.label !== undefined && b.labels !== undefined) {
            fail(`bone "${name}": use "label" or "labels", not both`, b);
        }
        if (b.label !== undefined) {
            labels = [integer(b.label, `bone "${name}" label`, b, 0, 255)];
        } else if (Array.isArray(b.labels)) {
            labels = (b.labels as unknown[]).map(l => integer(l, `bone "${name}" label`, b, 0, 255));
        } else if (b.labels === undefined) {
            labels = [];
        } else {
            fail(`bone "${name}" "labels" must be an array`, b);
        }
        for (const label of labels!) {
            const owner = labelOwner.get(label);
            if (owner !== undefined) {
                fail(`label ${label} belongs to two bones ("${owner}" and "${name}")`, b);
            }
            labelOwner.set(label, name);
        }
        if (b.parent !== undefined && b.parent !== null && typeof b.parent !== 'string') {
            fail(`bone "${name}" "parent" must be a bone name`, b);
        }
        const pivot = b.pivot === undefined ? null : numberTriple(b.pivot, `bone "${name}" "pivot"`, b).map(Math.round);
        if (!pivot && !labels!.length) {
            fail(`bone "${name}" has no labels, so it needs a "pivot"`, b);
        }
        const bone: RigBone = { name, labels: labels!, parent: (b.parent as string | undefined) ?? null, pivot: pivot as [number, number, number] | null, line: lineOf(b) };
        bones.push(bone);
        byName.set(name, bone);
    }
    const children = new Map<string, RigBone[]>();
    for (const bone of bones) {
        if (bone.parent !== null) {
            if (!byName.has(bone.parent)) {
                throw new AnimSourceError(`bone "${bone.name}" has parent "${bone.parent}", which is not a bone`, bone.line);
            }
            if (!children.has(bone.parent)) {
                children.set(bone.parent, []);
            }
            children.get(bone.parent)!.push(bone);
        }
        // cycle check
        const seen = new Set<string>([bone.name]);
        for (let p = bone.parent; p !== null; p = byName.get(p)?.parent ?? null) {
            if (seen.has(p)) {
                throw new AnimSourceError(`bone "${bone.name}" is its own ancestor (parent cycle)`, bone.line);
            }
            seen.add(p);
        }
    }

    // frames: pose per bone
    interface Pose {
        rotate: [number, number, number] | null;
        translate: [number, number, number] | null;
        scale: [number, number, number] | null;
    }
    const posed = (root.frames as unknown[]).map((frame, index) => {
        const { obj, name, delay } = frameHeader(frame, index, ['name', 'delay', 'pose']);
        const pose = new Map<string, Pose>();
        if (obj.pose !== undefined) {
            if (!isObject(obj.pose)) {
                fail(`frame "${name}" "pose" must be an object: { "<bone>": { "rotate": [x, y, z] } }`, obj);
            }
            for (const [boneName, value] of Object.entries(obj.pose as Json)) {
                if (!byName.has(boneName)) {
                    fail(`frame "${name}" poses "${boneName}", which is not a bone`, obj.pose);
                }
                if (!isObject(value)) {
                    fail(`frame "${name}" bone "${boneName}" must be { "rotate", "translate", "scale" }`, obj.pose);
                }
                const p = value as Json;
                checkKeys(p, ['rotate', 'translate', 'scale'], `frame "${name}" bone "${boneName}"`);
                let scale: [number, number, number] | null = null;
                if (typeof p.scale === 'number') {
                    scale = [p.scale, p.scale, p.scale];
                } else if (p.scale !== undefined) {
                    scale = numberTriple(p.scale, `frame "${name}" bone "${boneName}" "scale"`, p);
                }
                if (scale && scale.some(s => s < 0 || s > 127)) {
                    fail(`frame "${name}" bone "${boneName}": scale factors must be from 0 to 127`, p);
                }
                pose.set(boneName, {
                    rotate: p.rotate === undefined ? null : numberTriple(p.rotate, `frame "${name}" bone "${boneName}" "rotate"`, p),
                    translate: p.translate === undefined ? null : numberTriple(p.translate, `frame "${name}" bone "${boneName}" "translate"`, p),
                    scale
                });
            }
        }
        return { name, delay, pose, line: lineOf(obj) };
    });

    // bones in post-order: children before their parent
    const order: RigBone[] = [];
    const visit = (bone: RigBone) => {
        for (const child of children.get(bone.name) ?? []) {
            visit(child);
        }
        order.push(bone);
    };
    for (const bone of bones) {
        if (bone.parent === null) {
            visit(bone);
        }
    }
    const subtree = (bone: RigBone): number[] => [...bone.labels, ...(children.get(bone.name) ?? []).flatMap(subtree)];

    const base: AnimBaseDef = { types: [], labels: [] };
    const groupNames = new Map<string, number>();
    const addGroup = (name: string, type: number, labels: number[]) => {
        groupNames.set(name, base.types.length);
        base.types.push(type);
        base.labels.push(labels);
    };
    for (const bone of order) {
        const uses = (key: keyof Pose) => posed.some(f => f.pose.get(bone.name)?.[key]);
        const rotate = uses('rotate');
        const scale = uses('scale');
        const translate = uses('translate');
        const labels = subtree(bone);
        if (rotate || scale) {
            addGroup(`${bone.name}.origin`, AnimOp.ORIGIN, bone.pivot ? [] : bone.labels);
        }
        if (scale) {
            addGroup(`${bone.name}.scale`, AnimOp.SCALE, labels);
        }
        if (rotate) {
            addGroup(`${bone.name}.rotate`, AnimOp.ROTATE, labels);
        }
        if (translate) {
            addGroup(`${bone.name}.translate`, AnimOp.TRANSLATE, labels);
        }
    }
    if (base.types.length > 255) {
        throw new AnimSourceError(`the bones need ${base.types.length} base groups (max 255); use fewer bones or fewer kinds of transform`, lineOf(root.bones));
    }

    const frames: SourceFrame[] = posed.map(f => {
        const transforms: SourceTransform[] = [];
        for (const bone of order) {
            const p = f.pose.get(bone.name);
            if (!p) {
                continue;
            }
            if (p.rotate || p.scale) {
                transforms.push({ group: `${bone.name}.origin`, values: bone.pivot ?? [0, 0, 0], line: f.line });
            }
            if (p.scale) {
                transforms.push({ group: `${bone.name}.scale`, values: p.scale.map(s => Math.round(s * 128)), line: f.line });
            }
            if (p.rotate) {
                transforms.push({ group: `${bone.name}.rotate`, values: p.rotate.map(degreesToUnits), line: f.line });
            }
            if (p.translate) {
                transforms.push({ group: `${bone.name}.translate`, values: p.translate.map(Math.round), line: f.line });
            }
        }
        for (const t of transforms) {
            if (t.values.some(v => v === undefined || v < -16384 || v > 16383)) {
                throw new AnimSourceError(`frame "${f.name}": a value of ${t.group} is out of range (-16384..16383)`, f.line);
            }
        }
        return { name: f.name, delay: f.delay, transforms, line: f.line };
    });

    return { form: 'bones', base, baseRef: null, baseLine: lineOf(root), groupNames, frames, bones };
}

// Degrees to the client's angle units (256 per turn), wrapped to -128..127
export function degreesToUnits(degrees: number): number {
    const units = Math.round((degrees * 256) / 360);
    return ((((units + 128) % 256) + 256) % 256) - 128;
}

// Resolve group references against the final base. Transforms are sorted into
// base group order (the order the client applies them in).
export function resolveFrames(source: AnimSetSource, base: AnimBaseDef, groupNames: Map<string, number>): ResolvedFrame[] {
    return source.frames.map(frame => {
        const seen = new Set<number>();
        const transforms: AnimTransform[] = frame.transforms.map(t => {
            let group: number;
            if (typeof t.group === 'number') {
                group = t.group;
            } else {
                const named = groupNames.get(t.group);
                if (named === undefined) {
                    throw new AnimSourceError(`frame "${frame.name}": the base has no group named "${t.group}"`, t.line);
                }
                group = named;
            }
            if (group >= base.types.length) {
                throw new AnimSourceError(`frame "${frame.name}": group ${group} does not exist (the base has ${base.types.length} groups)`, t.line);
            }
            if (seen.has(group)) {
                throw new AnimSourceError(`frame "${frame.name}": group ${t.group} is used twice`, t.line);
            }
            seen.add(group);
            const def = defaultValue(base.types[group]);
            return { group, x: t.values[0] ?? def, y: t.values[1] ?? def, z: t.values[2] ?? def };
        });
        transforms.sort((a, b) => a.group - b.group);
        return { name: frame.name, delay: frame.delay, transforms, line: frame.line };
    });
}

// The base form of a decoded animset, for anim-unpack (frame ids -> names)
export function animSetToJson(base: AnimBaseDef, frames: { name: string; delay: number; transforms: AnimTransform[] }[], baseRef: string | null = null): string {
    const lines: string[] = ['{'];
    if (baseRef) {
        lines.push(`    "base": ${JSON.stringify(baseRef)},`);
    } else {
        lines.push('    "base": {');
        lines.push('        "groups": [');
        base.types.forEach((type, i) => {
            const comma = i < base.types.length - 1 ? ',' : '';
            lines.push(`            { "type": ${JSON.stringify(ANIM_OP_NAMES[type] ?? String(type))}, "labels": ${JSON.stringify(base.labels[i])} }${comma}`);
        });
        lines.push('        ]');
        lines.push('    },');
    }
    lines.push('    "frames": [');
    frames.forEach((frame, i) => {
        const comma = i < frames.length - 1 ? ',' : '';
        const transforms = frame.transforms.map(t => {
            const def = defaultValue(base.types[t.group]);
            const values = [t.x, t.y, t.z];
            while (values.length && values[values.length - 1] === def) {
                values.pop();
            }
            return JSON.stringify([t.group, ...values]);
        });
        lines.push(`        { "name": ${JSON.stringify(frame.name)}, "delay": ${frame.delay}, "transforms": [${transforms.join(', ')}] }${comma}`);
    });
    lines.push('    ]');
    lines.push('}');
    return lines.join('\n') + '\n';
}
