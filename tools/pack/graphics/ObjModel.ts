// Wavefront OBJ (+ MTL) to rev 245 model (.ob2).
//
// Axes: OBJ is y-up with the front of a model facing +z (Blender's default OBJ
// export). Rev 245 models have y pointing down and face -z. A point (x, y, z)
// becomes (x, -y, -z) * scale, a rotation (no mirroring), so winding and
// handedness are kept. The default scale is 128: one OBJ unit is one tile.
//
// Groups: the name of the current `g` (or `o`) statement picks the vertex
// label of the faces that follow (see ObjOptions.labels). A name with no faces
// under it needs no label, so Blender's "Vertex Groups" export (`o <object>`,
// then `g <vertex group>` lines) works. Back-face culling in the client agrees
// with OBJ: counter-clockwise faces seen from outside are the front. An OBJ
// vertex used by faces of different labels is split into one vertex per
// label, so the parts can move apart.
//
// Materials: `Kd r g b` gives the face colour (converted to the 16-bit HSL the
// client uses), `d` gives transparency, and `map_Kd <file>` makes the face
// textured with the texture named like the file (its basename without
// extension), resolved by ObjOptions.texture. A material named hsl_<n> uses
// colour <n> exactly. `s off` (the default) makes the following faces flat
// shaded; `s 1` (any other value) smooth.

import { Ob2Model } from '#tools/pack/graphics/Ob2.js';

export class ObjError extends Error {
    readonly file: string;
    readonly line: number | null;

    constructor(message: string, file: string, line: number | null) {
        super(message);
        this.file = file;
        this.line = line;
    }
}

export interface ObjOptions {
    // OBJ units to model units (default 128: one unit is one tile)
    scale?: number;
    // group name -> vertex label. Groups not listed: a name like label_<n> or
    // <n> gives label n; otherwise label 0, or an error when `strictLabels`.
    labels?: Map<string, number>;
    strictLabels?: boolean;
    // write face labels (the label of each face's group) and an alpha section
    // even when every face is opaque, for alpha animations: the client only
    // applies alpha transforms to a model with both
    faceLabels?: boolean;
    // render priority of every face (0-11, default 0)
    priority?: number;
    // texture name -> texture id, or undefined if there is no such texture
    texture?: (name: string) => number | undefined;
    // read the .mtl named by mtllib (relative to the OBJ); null if missing
    readMtl?: (name: string) => string | null;
}

export interface ObjResult {
    model: Ob2Model;
    // group name -> label actually used
    groups: Map<string, number>;
    warnings: string[];
}

interface Material {
    colour: number;
    alpha: number;
    texture: string | null;
}

const DEFAULT_COLOUR = rgbToHsl16(0.6, 0.6, 0.6);

// RGB (0-1) to the client's 16-bit colour: 6 bits hue, 3 bits saturation,
// 7 bits lightness (see Pix3D.initColourTable).
export function rgbToHsl16(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
        const d = max - min;
        s = l < 0.5 ? d / (max + min) : d / (2 - max - min);
        if (max === r) {
            h = (g - b) / d + (g < b ? 6 : 0);
        } else if (max === g) {
            h = (b - r) / d + 2;
        } else {
            h = (r - g) / d + 4;
        }
        h /= 6;
    }
    const hue = Math.min(63, Math.floor(h * 64));
    const sat = Math.min(7, Math.floor(s * 8));
    const light = Math.min(127, Math.round(l * 128));
    return (hue << 10) | (sat << 7) | light;
}

function parseMtl(text: string, file: string): Map<string, Material> {
    const out = new Map<string, Material>();
    let current: Material | null = null;
    let exactColour = false;
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            return;
        }
        const [key, ...rest] = line.split(/\s+/);
        if (key === 'newmtl') {
            const name = rest.join(' ');
            current = { colour: DEFAULT_COLOUR, alpha: 0, texture: null };
            const exact = /^hsl_(\d+)$/.exec(name);
            exactColour = exact !== null;
            if (exact) {
                current.colour = parseInt(exact[1]);
                if (current.colour > 65535) {
                    throw new ObjError(`material ${name}: colour ${current.colour} is out of range (0-65535)`, file, i + 1);
                }
            }
            out.set(name, current);
            return;
        }
        if (!current) {
            return;
        }
        const nums = rest.map(Number);
        if (key === 'Kd' && !exactColour) {
            if (nums.length < 3 || nums.slice(0, 3).some(n => !Number.isFinite(n))) {
                throw new ObjError('Kd needs three numbers', file, i + 1);
            }
            current.colour = rgbToHsl16(clamp01(nums[0]), clamp01(nums[1]), clamp01(nums[2]));
        } else if (key === 'd' && Number.isFinite(nums[0])) {
            current.alpha = Math.round((1 - clamp01(nums[0])) * 255);
        } else if (key === 'Tr' && Number.isFinite(nums[0])) {
            current.alpha = Math.round(clamp01(nums[0]) * 255);
        } else if (key === 'map_Kd') {
            // the last token is the file; options like -s may come before it
            const tex = rest[rest.length - 1].replace(/\\/g, '/');
            const base = tex.substring(tex.lastIndexOf('/') + 1);
            current.texture = base.includes('.') ? base.substring(0, base.lastIndexOf('.')) : base;
        }
    });
    return out;
}

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
}

export function convertObj(text: string, file: string, options: ObjOptions = {}): ObjResult {
    const scale = options.scale ?? 128;
    const warnings: string[] = [];
    const positions: [number, number, number][] = [];
    const uvs: [number, number][] = [];
    const materials = new Map<string, Material>();

    const model: Ob2Model = {
        vertexX: [],
        vertexY: [],
        vertexZ: [],
        vertexLabel: [],
        faceA: [],
        faceB: [],
        faceC: [],
        faceColour: [],
        faceInfo: [],
        facePriority: null,
        priority: options.priority ?? 0,
        faceAlpha: [],
        faceLabel: [],
        texP: [],
        texM: [],
        texN: []
    };

    // (obj vertex, label) -> model vertex
    const vertexMap = new Map<string, number>();
    const groups = new Map<string, number>();
    const textureMappings = new Map<string, number>();
    let group = '';
    let groupLine = 0;
    // resolved at the first face of a group: exporters write `o <object>`
    // before the `g <vertex group>` lines (Blender), and a name with no faces
    // under it must not need a label
    let label: number | null = null;
    let material: Material | null = null;
    let materialName = '';
    let smooth = false;
    let missingMaterialWarned = false;

    const labelFor = (name: string, line: number): number => {
        const known = groups.get(name);
        if (known !== undefined) {
            return known;
        }
        let value = options.labels?.get(name);
        if (value === undefined) {
            const match = /^(?:label_?)?(\d+)$/.exec(name);
            if (match) {
                value = parseInt(match[1]);
            }
        }
        if (value === undefined) {
            if (options.strictLabels && name !== '') {
                throw new ObjError(`group "${name}" has no label: add it to "labels", name it after a bone, or name it label_<n>`, file, line);
            }
            value = 0;
        }
        if (!Number.isInteger(value) || value < 0 || value > 255) {
            throw new ObjError(`group "${name}" has label ${value} (labels are 0-255)`, file, line);
        }
        groups.set(name, value);
        return value;
    };

    const addVertex = (x: number, y: number, z: number, vLabel: number, key: string | null): number => {
        if (key !== null) {
            const existing = vertexMap.get(key);
            if (existing !== undefined) {
                return existing;
            }
        }
        const index = model.vertexX.length;
        model.vertexX.push(x);
        model.vertexY.push(y);
        model.vertexZ.push(z);
        model.vertexLabel!.push(vLabel);
        if (key !== null) {
            vertexMap.set(key, index);
        }
        return index;
    };

    const toModel = (p: [number, number, number]): [number, number, number] => [Math.round(p[0] * scale), Math.round(-p[1] * scale), Math.round(-p[2] * scale)];

    const resolveIndex = (token: string, count: number, what: string, line: number): number => {
        const n = parseInt(token);
        if (!Number.isInteger(n) || n === 0) {
            throw new ObjError(`bad ${what} index "${token}"`, file, line);
        }
        const index = n > 0 ? n - 1 : count + n;
        if (index < 0 || index >= count) {
            throw new ObjError(`${what} index ${n} does not exist`, file, line);
        }
        return index;
    };

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        let line = lines[i];
        while (line.endsWith('\\') && i + 1 < lines.length) {
            line = line.slice(0, -1) + ' ' + lines[++i];
        }
        line = line.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const [key, ...rest] = line.split(/\s+/);
        if (key === 'v') {
            const p = rest.slice(0, 3).map(Number);
            if (p.length < 3 || p.some(n => !Number.isFinite(n))) {
                throw new ObjError('v needs three numbers', file, lineNo);
            }
            positions.push(p as [number, number, number]);
        } else if (key === 'vt') {
            const t = rest.slice(0, 2).map(Number);
            if (!Number.isFinite(t[0])) {
                throw new ObjError('vt needs a number', file, lineNo);
            }
            uvs.push([t[0], Number.isFinite(t[1]) ? t[1] : 0]);
        } else if (key === 'g' || key === 'o') {
            group = rest[0] ?? '';
            groupLine = lineNo;
            label = null;
        } else if (key === 'usemtl') {
            materialName = rest.join(' ');
            material = materials.get(materialName) ?? null;
            if (!material) {
                const exact = /^hsl_(\d+)$/.exec(materialName);
                if (exact) {
                    material = { colour: parseInt(exact[1]) & 0xffff, alpha: 0, texture: null };
                } else {
                    warnings.push(`line ${lineNo}: material "${materialName}" is not defined (using grey)`);
                }
            }
        } else if (key === 'mtllib') {
            const name = rest.join(' ');
            const mtl = options.readMtl?.(name) ?? null;
            if (mtl === null) {
                warnings.push(`line ${lineNo}: material library ${name} not found (faces will be grey)`);
            } else {
                for (const [n, m] of parseMtl(mtl, name)) {
                    materials.set(n, m);
                }
            }
        } else if (key === 's') {
            smooth = !(rest[0] === 'off' || rest[0] === '0');
        } else if (key === 'f') {
            if (rest.length < 3) {
                throw new ObjError('a face needs at least three vertices', file, lineNo);
            }
            if (label === null) {
                label = labelFor(group, group === '' ? lineNo : groupLine);
            }
            const faceLabel: number = label;
            const corners = rest.map(token => {
                const [v, vt] = token.split('/');
                const pi = resolveIndex(v, positions.length, 'vertex', lineNo);
                const ti = vt ? resolveIndex(vt, uvs.length, 'texture coordinate', lineNo) : -1;
                return { pi, ti };
            });
            const mat = material ?? { colour: DEFAULT_COLOUR, alpha: 0, texture: null };
            if (!material && !missingMaterialWarned && materialName === '') {
                warnings.push('faces without a material are grey');
                missingMaterialWarned = true;
            }

            let textureId: number | undefined;
            if (mat.texture !== null) {
                textureId = options.texture?.(mat.texture);
                if (textureId === undefined) {
                    throw new ObjError(`material "${materialName}" uses texture "${mat.texture}", which is not a texture name`, file, lineNo);
                }
                if (corners.some(c => c.ti < 0)) {
                    throw new ObjError(`a face with textured material "${materialName}" has no texture coordinates (vt)`, file, lineNo);
                }
            }

            // fan triangulation
            for (let k = 1; k + 1 < corners.length; k++) {
                const tri = [corners[0], corners[k], corners[k + 1]];
                const idx = tri.map(c => {
                    const p = toModel(positions[c.pi]);
                    return addVertex(p[0], p[1], p[2], faceLabel, `${c.pi}:${faceLabel}`);
                });
                model.faceA.push(idx[0]);
                model.faceB.push(idx[1]);
                model.faceC.push(idx[2]);
                model.faceLabel!.push(faceLabel);
                model.faceAlpha!.push(mat.alpha);
                if (textureId === undefined) {
                    model.faceColour.push(mat.colour);
                    model.faceInfo!.push(smooth ? 0 : 1);
                    continue;
                }

                // texture axes: P is texel (0,0), M is (1,0), N is (0,1), rows
                // going down the image; OBJ v goes up the image.
                const pos = tri.map(c => toModel(positions[c.pi]));
                const st = tri.map(c => [uvs[c.ti][0], 1 - uvs[c.ti][1]]);
                const s0 = Math.floor(Math.min(st[0][0], st[1][0], st[2][0]) + 1e-6);
                const t0 = Math.floor(Math.min(st[0][1], st[1][1], st[2][1]) + 1e-6);
                if (Math.max(st[0][0], st[1][0], st[2][0]) - s0 > 1 + 1e-6) {
                    warnings.push(`line ${lineNo}: a textured face spans more than one texture width; the client does not repeat textures horizontally`);
                }
                const ds = [st[1][0] - st[0][0], st[2][0] - st[0][0]];
                const dt = [st[1][1] - st[0][1], st[2][1] - st[0][1]];
                const det = ds[0] * dt[1] - ds[1] * dt[0];
                if (Math.abs(det) < 1e-9) {
                    throw new ObjError('a textured face has degenerate texture coordinates (all on one line)', file, lineNo);
                }
                const e1 = [0, 1, 2].map(j => pos[1][j] - pos[0][j]);
                const e2 = [0, 1, 2].map(j => pos[2][j] - pos[0][j]);
                const axisS = [0, 1, 2].map(j => (dt[1] * e1[j] - dt[0] * e2[j]) / det);
                const axisT = [0, 1, 2].map(j => (ds[0] * e2[j] - ds[1] * e1[j]) / det);
                const at = (s: number, t: number) => [0, 1, 2].map(j => Math.round(pos[0][j] + (s - st[0][0]) * axisS[j] + (t - st[0][1]) * axisT[j]));
                const P = at(s0, t0);
                const M = at(s0 + 1, t0);
                const N = at(s0, t0 + 1);
                const mapKey = `${faceLabel}:${P}:${M}:${N}`;
                let mapping = textureMappings.get(mapKey);
                if (mapping === undefined) {
                    mapping = model.texP.length;
                    textureMappings.set(mapKey, mapping);
                    model.texP.push(addVertex(P[0], P[1], P[2], faceLabel, `t${P}:${faceLabel}`));
                    model.texM.push(addVertex(M[0], M[1], M[2], faceLabel, `t${M}:${faceLabel}`));
                    model.texN.push(addVertex(N[0], N[1], N[2], faceLabel, `t${N}:${faceLabel}`));
                }
                model.faceColour.push(textureId);
                model.faceInfo!.push((mapping << 2) | (smooth ? 2 : 3));
            }
        }
        // vn, l, p, cstype ... are ignored
    }

    if (!model.faceA.length) {
        throw new ObjError('the OBJ has no faces', file, null);
    }
    if (model.texP.length > 255) {
        throw new ObjError(`${model.texP.length} different texture mappings (max 255): share UV layouts between faces`, file, null);
    }
    if (model.vertexX.length > 4096 || model.faceA.length > 4096) {
        throw new ObjError(`${model.vertexX.length} vertices and ${model.faceA.length} faces: the client draws at most 4096 of each per model`, file, null);
    }
    if (model.faceA.length > 2000) {
        warnings.push(`${model.faceA.length} faces: the client sorts at most 2000 faces of one priority, use fewer`);
    }

    // drop optional sections that carry nothing
    if (model.vertexLabel!.every(l => l === 0)) {
        model.vertexLabel = null;
    }
    if (!options.faceLabels) {
        model.faceLabel = null;
    }
    if (!options.faceLabels && model.faceAlpha!.every(a => a === 0)) {
        model.faceAlpha = null;
    }
    if (model.faceInfo!.every(info => info === 0)) {
        model.faceInfo = null;
    }

    return { model, groups, warnings };
}
