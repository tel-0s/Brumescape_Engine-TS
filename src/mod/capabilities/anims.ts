// Capability: animations.
//
// Mod layout: anims/**/<set>.json, one animation set per file (the unit of
// cache archive 2: one base plus its frames). Two JSON forms, see
// tools/pack/graphics/AnimSource.ts: a base form (groups + [group, x, y, z]
// transforms) and a bone form (bones with pivots + rotate/translate/scale per
// bone), which is compiled into the base form.
//
// Names and ids:
// - The file name is the animset name. A new name gets a stable animset id
//   (idmap kind 'animset') after the base sets. A base set name (anim_<n>)
//   overrides that set: its frames are kept unless the mod redefines them,
//   and the base is kept unless the mod gives one.
// - Every frame has a name. Seq configs use it (frame1=<name>). A new name gets
//   a stable frame id (idmap kind 'frame') after the base frames. A base frame
//   name (anim_<n>) overrides that frame: it moves into the mod set, and its
//   old base set is repacked without it.
// - The same set or frame name in two mods: the later mod wins (warning). The
//   same name twice in one mod is an error.
//
// Output: each new or changed set is encoded into data/pack/mods/anims/<set>.anim
// and registered with setAsset('animset', ...). The anim packer
// (tools/pack/graphics/pack.ts) writes those over the base sets.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';
import { printInfo } from '#/util/Logger.js';
import { AnimBaseDef, AnimSetDef, AnimTransform, decodeAnimSet, encodeAnimSet, readAnimSetFrameIds, sameBase, validateAnimSet } from '#tools/pack/graphics/AnimSet.js';
import { AnimSetSource, AnimSourceError, NAME_PATTERN, parseAnimSetSource, resolveFrames } from '#tools/pack/graphics/AnimSource.js';
import { AnimPack, AnimSetPack, BasePack } from '#tools/pack/PackFile.js';
import { listFilesExt } from '#tools/pack/Parse.js';

// Highest frame id: seq configs store frames as 16-bit values and 65535 means
// "no frame" for iframes.
export const MAX_FRAME_ID = 65534;

interface SetEntry {
    name: string;
    file: ModFile;
    source: AnimSetSource;
    resolved: { base: AnimBaseDef; groupNames: Map<string, number> } | null;
    resolving: boolean;
}

interface OutFrame {
    name: string;
    delay: number;
    transforms: AnimTransform[];
    line: number | null;
}

interface OutSet {
    name: string;
    base: AnimBaseDef;
    frames: OutFrame[];
    // null for a base set that only lost frames to mod sets
    file: ModFile | null;
    line: number | null;
}

// Base content animsets, read on demand
class BaseSets {
    private files: Map<string, string> | null = null;
    private decoded = new Map<string, AnimSetDef>();
    private frameOwner: Map<number, string> | null = null;

    private list(): Map<string, string> {
        if (!this.files) {
            this.files = new Map();
            for (const file of listFilesExt(`${Environment.BUILD_SRC_DIR}/models`, '.anim')) {
                this.files.set(path.basename(file, '.anim'), file);
            }
        }
        return this.files;
    }

    has(name: string): boolean {
        return ModManager.isBaseName(AnimSetPack, name) && this.list().has(name);
    }

    get(name: string): AnimSetDef {
        let set = this.decoded.get(name);
        if (!set) {
            set = decodeAnimSet(new Uint8Array(fs.readFileSync(this.list().get(name)!)));
            this.decoded.set(name, set);
        }
        return set;
    }

    // base frame id -> base set name
    ownerOf(frameId: number): string | undefined {
        if (!this.frameOwner) {
            this.frameOwner = new Map();
            for (const [name, file] of this.list()) {
                for (const id of readAnimSetFrameIds(new Uint8Array(fs.readFileSync(file)))) {
                    this.frameOwner.set(id, name);
                }
            }
        }
        return this.frameOwner.get(frameId);
    }
}

function fail(file: ModFile, err: unknown): never {
    if (err instanceof AnimSourceError) {
        throw ModManager.error(file, err.line, err.message);
    }
    throw err;
}

const capability: ModCapability = {
    name: 'anims',

    // Before configs: seq configs resolve frame names through AnimPack.
    afterRevalidate() {
        const staging = ModManager.stagingDir('anims');
        for (const old of fs.readdirSync(staging)) {
            fs.rmSync(path.join(staging, old), { recursive: true, force: true });
        }

        const binary = ModManager.listFiles('anims', '.anim')[0];
        if (binary) {
            const json = path.relative(process.cwd(), binary.path).replace(/\.anim$/i, '.json');
            throw ModManager.error(binary, null, `mods use JSON animsets, not binary .anim files. Convert it, then delete the .anim: bun run mod:art anim-unpack ${path.relative(process.cwd(), binary.path)} ${json}`);
        }
        const files = ModManager.listFiles('anims', '.json');
        if (!files.length) {
            return;
        }

        // 1. parse; the later mod wins a set name
        const sets = new Map<string, SetEntry>();
        for (const file of files) {
            if (!NAME_PATTERN.test(file.name)) {
                throw ModManager.error(file, null, 'animset file names may only use letters, digits and _');
            }
            const previous = ModManager.claim('animset', file.name, file);
            if (previous && previous.mod === file.mod) {
                throw ModManager.error(file, null, `animset ${file.name} is also defined in ${previous.relPath}`);
            }
            let source: AnimSetSource;
            try {
                source = parseAnimSetSource(fs.readFileSync(file.path, 'utf-8'));
            } catch (err) {
                fail(file, err);
            }
            sets.set(file.name, { name: file.name, file, source: source!, resolved: null, resolving: false });
        }

        // 2. frame names, in load order; the later mod wins a frame name
        const frameSet = new Map<string, string>();
        for (const file of files) {
            const entry = sets.get(file.name);
            if (!entry || entry.file !== file) {
                continue;
            }
            for (const frame of entry.source.frames) {
                const previous = ModManager.claim('frame', frame.name, file);
                if (previous && previous.mod === file.mod) {
                    throw ModManager.error(file, frame.line, `frame ${frame.name} is also defined in ${previous.relPath}`);
                }
                frameSet.set(frame.name, entry.name);
            }
        }
        for (const entry of sets.values()) {
            entry.source.frames = entry.source.frames.filter(frame => frameSet.get(frame.name) === entry.name);
        }

        // 3. bases
        const baseSets = new BaseSets();
        const resolve = (entry: SetEntry): { base: AnimBaseDef; groupNames: Map<string, number> } => {
            if (entry.resolved) {
                return entry.resolved;
            }
            if (entry.resolving) {
                throw ModManager.error(entry.file, entry.source.baseLine, `"base" references form a cycle through animset ${entry.name}`);
            }
            entry.resolving = true;
            const { source, file } = entry;
            let resolved: { base: AnimBaseDef; groupNames: Map<string, number> };
            if (source.base) {
                resolved = { base: source.base, groupNames: source.groupNames };
            } else if (source.baseRef !== null) {
                const ref = source.baseRef;
                const modSet = sets.get(ref);
                if (modSet) {
                    resolved = resolve(modSet);
                } else if (ModManager.isBaseName(BasePack, ref) && baseSets.has(AnimSetPack.getById(BasePack.getByName(ref)))) {
                    resolved = { base: baseSets.get(AnimSetPack.getById(BasePack.getByName(ref))).base, groupNames: new Map() };
                } else if (baseSets.has(ref)) {
                    resolved = { base: baseSets.get(ref).base, groupNames: new Map() };
                } else {
                    throw ModManager.error(file, source.baseLine, `"base": "${ref}" is not a base (base_<n>) or an animset`);
                }
            } else if (baseSets.has(entry.name)) {
                resolved = { base: baseSets.get(entry.name).base, groupNames: new Map() };
            } else {
                throw ModManager.error(file, source.baseLine, 'needs a "base": { "groups": [...] }, the name of a base (base_<n>) or animset, or "bones"');
            }
            entry.resolving = false;
            entry.resolved = resolved;
            return resolved;
        };

        // 4. the sets to pack
        const out = new Map<string, OutSet>();
        for (const entry of sets.values()) {
            const { base, groupNames } = resolve(entry);
            let frames: OutFrame[];
            try {
                frames = resolveFrames(entry.source, base, groupNames);
            } catch (err) {
                fail(entry.file, err);
            }

            if (baseSets.has(entry.name)) {
                // override of a base set: keep the frames no mod redefines
                const original = baseSets.get(entry.name);
                const kept: OutFrame[] = [];
                for (const frame of original.frames) {
                    const name = AnimPack.getById(frame.id);
                    if (!frameSet.has(name)) {
                        kept.push({ name, delay: frame.delay, transforms: frame.transforms, line: null });
                    }
                }
                if (kept.length && !sameBase(base, original.base)) {
                    const names =
                        kept
                            .slice(0, 5)
                            .map(f => f.name)
                            .join(', ') + (kept.length > 5 ? `, ... (${kept.length})` : '');
                    throw ModManager.error(entry.file, entry.source.baseLine, `replaces the base of animset ${entry.name}, but does not redefine its frames ${names}. Redefine them, or keep the original base (leave out "base").`);
                }
                printInfo(`[mods] ${entry.file.mod.name} replaces base animset ${entry.name} (${frames!.length} frames from the mod, ${kept.length} kept)`);
                frames = [...kept, ...frames!];
            }
            out.set(entry.name, { name: entry.name, base, frames: frames!, file: entry.file, line: entry.source.baseLine });
        }

        // base frames that moved into another set leave their base set
        const losing = new Map<string, Set<string>>();
        for (const [frameName, setName] of frameSet) {
            if (!ModManager.isBaseName(AnimPack, frameName)) {
                continue;
            }
            const owner = baseSets.ownerOf(AnimPack.getByName(frameName));
            if (owner === undefined || owner === setName || sets.has(owner)) {
                continue;
            }
            if (!losing.has(owner)) {
                losing.set(owner, new Set());
            }
            losing.get(owner)!.add(frameName);
        }
        for (const [owner, moved] of losing) {
            const original = baseSets.get(owner);
            const frames = original.frames.filter(f => !moved.has(AnimPack.getById(f.id))).map(f => ({ name: AnimPack.getById(f.id), delay: f.delay, transforms: f.transforms, line: null }));
            printInfo(`[mods] base animset ${owner} is repacked without ${moved.size} frame(s) that mods redefine: ${Array.from(moved).slice(0, 5).join(', ')}${moved.size > 5 ? ', ...' : ''}`);
            out.set(owner, { name: owner, base: original.base, frames, file: null, line: null });
        }

        // 5. ids, encode, stage
        for (const set of out.values()) {
            // a base set that only lost frames has no file of its own
            const where = set.file ?? files[0].mod;
            ModManager.registerName('animset', AnimSetPack, set.name);
            const def: AnimSetDef = {
                base: set.base,
                frames: set.frames.map(frame => {
                    const id = ModManager.registerName('frame', AnimPack, frame.name);
                    if (id > MAX_FRAME_ID) {
                        throw ModManager.error(where, frame.line, `frame ${frame.name} got id ${id}, above the limit of ${MAX_FRAME_ID}`);
                    }
                    return { id, delay: frame.delay, transforms: frame.transforms };
                })
            };
            const errors = validateAnimSet(def);
            if (errors.length) {
                throw ModManager.error(where, set.line, `animset ${set.name}: ${errors[0]}`);
            }
            const target = path.join(staging, `${set.name}.anim`);
            fs.writeFileSync(target, encodeAnimSet(def));
            ModManager.setAsset('animset', set.name, target);
        }
    }
};

export default capability;
