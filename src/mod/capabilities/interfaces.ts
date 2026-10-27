// Capability: interfaces (.if) - new interfaces, base interface replacement
// and component patches.
//
// Mod layout:
//   interfaces/**/<name>.if        a whole interface, same syntax as content/scripts/**/interfaces/*.if.
//                                  A new name adds an interface. A base (or earlier mod's) name
//                                  replaces that interface entirely; later mods win (warning).
//                                  Interface properties the replacement does not set (type=overlay)
//                                  are kept; left-out components stay as empty hidden layers.
//   interfaces/**/<name>.ifpatch   changes to an existing interface: [com] sections whose name exists
//                                  set or override those properties, other [com] sections add new
//                                  components (appended, so drawn on top). Lines before the first
//                                  section change the interface's own properties.
//
// Ids: interfaces and their components share one id space (content/pack/interface.pack, idmap kind
// 'interface'). A new interface or component name gets a stable id after base content. The client
// archive lists components grouped by interface (content/pack/interface.order); mod ids are inserted
// after the last entry of their interface by tools/pack/interface/PackShared.ts.
//
// Layout helper: y=end or y=end+N puts a component N pixels below the lowest sibling (same parent
// layer) that comes before it. If it then ends below a scrolling parent layer's scroll height, that
// height grows to fit it (keeping the layer's bottom margin). This lets several mods append entries
// to a list (e.g. the quest list) without knowing about each other.
//
// Build flow (every build, afterRevalidate): resolve whole files (later mod wins), apply patches in
// load order, register names (ModManager.registerName), validate everything mods wrote, then write
// the effective source of every interface mods touched to data/pack/mods/interfaces/<name>.if and
// set it as asset 'interface' <name>. The interface packer reads that instead of the base file.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';
import { printInfo, printWarning } from '#/util/Logger.js';
import { getSpriteShape } from '#/mod/capabilities/sprites.js';
import { InterfacePack, ModelPack, ObjPack, SeqPack, VarpPack } from '#tools/pack/PackFile.js';
import { listFilesExt } from '#tools/pack/Parse.js';

export const INTERFACE_NAME = /^[a-z0-9_]+$/;

// Where a property value came from: base content, or a line in a mod file
interface Origin {
    file: ModFile;
    line: number;
}

interface IfComponent {
    name: string;
    props: Map<string, string>;
    // per property: the mod line that set it (absent for base values)
    origins: Map<string, Origin>;
    // header line in a mod file, or null for base content
    origin: Origin | null;
    // a mod created or changed this component (it is validated)
    touched: boolean;
}

interface IfDef {
    name: string;
    root: IfComponent;
    components: IfComponent[];
    byName: Map<string, IfComponent>;
    // defined by base content, or by a mod's whole .if file
    from: 'base' | ModFile;
    // base components a replacement left out (packed as empty, hidden layers)
    placeholders: string[];
}

// One parsed mod file: properties before the first section, then sections
interface ParsedSection {
    name: string;
    line: number;
    props: { key: string; value: string; line: number }[];
}

const NUMBER = /^-?(0x[0-9a-f]+|\d+)$/i;
const COMPONENT_TYPES = ['layer', 'inv', 'rect', 'text', 'graphic', 'model', 'invtext'];
const BUTTON_TYPES = ['none', 'normal', 'target', 'close', 'toggle', 'select', 'pause'];
const FONTS = ['p11', 'p12', 'b12', 'q8'];
const COMPARATORS = ['eq', 'lt', 'gt', 'neq'];
const STATS = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'runecraft'];
const ACTION_TARGETS = ['obj', 'npc', 'loc', 'player', 'heldobj'];
const YES_NO = ['hide', 'draggable', 'interactable', 'usable', 'swappable', 'fill', 'center', 'shadowed'];
const INTS = ['clientcode', 'width', 'height', 'trans', 'scroll', 'x', 'y', 'zoom', 'xan', 'yan'];
const COLOURS = ['colour', 'activecolour', 'overcolour', 'activeovercolour'];
const STRINGS = ['text', 'activetext', 'option', 'actionverb', 'action'];
const KNOWN_KEYS = new Set([...YES_NO, ...INTS, ...COLOURS, ...STRINGS, 'type', 'buttontype', 'layer', 'overlayer', 'margin', 'font', 'graphic', 'activegraphic', 'model', 'activemodel', 'anim', 'activeanim', 'actiontarget']);
const INDEXED_KEY = /^(script[1-5]op([1-9]|1[0-9]|20)|script[1-5]|slot([1-9]|1[0-9]|20)|option[1-5])$/;
const Y_END = /^end(\+\d+)?$/;

function isKnownKey(key: string): boolean {
    return KNOWN_KEYS.has(key) || INDEXED_KEY.test(key);
}

function newComponent(name: string, origin: Origin | null): IfComponent {
    return { name, props: new Map(), origins: new Map(), origin, touched: origin !== null };
}

function newDef(name: string, from: 'base' | ModFile): IfDef {
    return { name, root: newComponent(name, null), components: [], byName: new Map(), from, placeholders: [] };
}

// Mod files are UTF-8; base files are read as ASCII, like the packer does
function readLines(file: string, encoding: 'utf-8' | 'ascii'): string[] {
    return fs.readFileSync(file, encoding).replace(/\r/g, '').split('\n');
}

// A mod .if/.ifpatch file. Blank lines and lines starting with // are
// skipped; leading and trailing spaces are ignored.
function parseModFile(file: ModFile): { root: ParsedSection; sections: ParsedSection[] } {
    const root: ParsedSection = { name: '', line: 0, props: [] };
    const sections: ParsedSection[] = [];
    let current = root;

    const lines = readLines(file.path, 'utf-8');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const lineNo = i + 1;
        if (line.length === 0 || line.startsWith('//')) {
            continue;
        }

        if (line.startsWith('[')) {
            if (!line.endsWith(']')) {
                throw ModManager.error(file, lineNo, `missing closing bracket: ${line}`);
            }
            const name = line.substring(1, line.length - 1);
            if (!INTERFACE_NAME.test(name)) {
                throw ModManager.error(file, lineNo, `invalid component name '${name}': use lower-case letters, digits and _`);
            }
            const first = sections.find(s => s.name === name);
            if (first) {
                throw ModManager.error(file, lineNo, `component [${name}] is already defined on line ${first.line}`);
            }
            current = { name, line: lineNo, props: [] };
            sections.push(current);
            continue;
        }

        const eq = line.indexOf('=');
        if (eq <= 0) {
            throw ModManager.error(file, lineNo, `expected key=value or [component]: ${line}`);
        }
        const key = line.substring(0, eq).trim();
        const value = line.substring(eq + 1).trim();
        const wide = Array.from(value).find(c => c.charCodeAt(0) > 0xff);
        if (wide !== undefined) {
            throw ModManager.error(file, lineNo, `character '${wide}' cannot be stored in the cache (Latin-1 characters only)`);
        }
        if (!isKnownKey(key)) {
            throw ModManager.error(file, lineNo, `unknown interface property '${key}'`);
        }
        const first = current.props.find(p => p.key === key);
        if (first) {
            throw ModManager.error(file, lineNo, `${key} is already set on line ${first.line}`);
        }
        current.props.push({ key, value, line: lineNo });
    }

    return { root, sections };
}

// A base interface file, read the way tools/pack/interface/PackShared.ts
// reads it (non-empty lines, later keys win).
function parseBaseFile(name: string, file: string): IfDef {
    const def = newDef(name, 'base');
    let current = def.root;
    for (const line of readLines(file, 'ascii')) {
        if (!line) {
            continue;
        }
        if (line.startsWith('[')) {
            current = newComponent(line.substring(1, line.length - 1), null);
            def.components.push(current);
            def.byName.set(current.name, current);
            continue;
        }
        const eq = line.indexOf('=');
        current.props.set(line.substring(0, eq), line.substring(eq + 1));
    }
    return def;
}

function setProp(def: IfDef, com: IfComponent, key: string, value: string, origin: Origin) {
    const previous = com.origins.get(key);
    if (previous && previous.file.mod !== origin.file.mod && com.props.get(key) !== value) {
        const where = com === def.root ? def.name : `${def.name}:${com.name}`;
        printWarning(`[mods] ${where} ${key}=${com.props.get(key)} from ${previous.file.mod.name} (${previous.file.relPath}:${previous.line}) is overridden by ${origin.file.mod.name} (${origin.file.relPath}:${origin.line}): ${key}=${value}`);
    }
    com.props.set(key, value);
    com.origins.set(key, origin);
    com.touched = true;
}

function intProp(com: IfComponent, key: string): number {
    const value = parseInt(com.props.get(key) ?? '', 10);
    return isNaN(value) ? 0 : value;
}

// y=end[+N]: below the lowest earlier sibling in the same parent layer. When
// the component ends below a scrolling parent layer's scroll height, that
// height grows to fit it plus the space the layer had below its lowest
// earlier child (the quest list: 9 pixels).
function resolveYEnd(def: IfDef, com: IfComponent) {
    const value = com.props.get('y');
    if (value === undefined || !Y_END.test(value)) {
        return;
    }
    const gap = value.length > 3 ? parseInt(value.substring(4), 10) : 0;
    const parent = com.props.get('layer');

    let end = 0;
    for (const sibling of def.components) {
        if (sibling === com) {
            break;
        }
        if (sibling.props.get('layer') === parent) {
            end = Math.max(end, intProp(sibling, 'y') + intProp(sibling, 'height'));
        }
    }

    const y = end + gap;
    com.props.set('y', String(y));

    const layer = parent !== undefined ? def.byName.get(parent) : undefined;
    const scroll = layer ? intProp(layer, 'scroll') : 0;
    const bottom = y + intProp(com, 'height');
    if (layer && scroll > 0 && bottom > scroll) {
        layer.props.set('scroll', String(bottom + Math.max(0, scroll - end)));
        layer.touched = true;
    }
}

// Apply one parsed mod file (a whole .if, or a .ifpatch) on top of `def`
function applySections(def: IfDef, file: ModFile, parsed: { root: ParsedSection; sections: ParsedSection[] }, patch: boolean) {
    for (const prop of parsed.root.props) {
        setProp(def, def.root, prop.key, prop.value, { file, line: prop.line });
    }

    for (const section of parsed.sections) {
        let com = def.byName.get(section.name);
        if (!com) {
            com = newComponent(section.name, { file, line: section.line });
            def.components.push(com);
            def.byName.set(com.name, com);
            if (patch && !section.props.some(p => p.key === 'type')) {
                throw ModManager.error(file, section.line, `[${section.name}] is not a component of ${def.name}; a new component needs type=`);
            }
        }
        for (const prop of section.props) {
            setProp(def, com, prop.key, prop.value, { file, line: prop.line });
        }
        resolveYEnd(def, com);
    }
}

// ----------------------------------------------------------------------------
// Validation of everything mods wrote (base content is trusted as-is)

function fail(com: IfComponent, key: string | null, message: string): Error {
    const origin = (key !== null ? com.origins.get(key) : undefined) ?? com.origin;
    if (origin) {
        return ModManager.error(origin.file, origin.line, message);
    }
    return new Error(`[mods] ${message}`);
}

function checkSprite(com: IfComponent, key: string, value: string) {
    const comma = value.lastIndexOf(',');
    const name = comma === -1 ? value : value.substring(0, comma);
    const index = comma === -1 ? NaN : parseInt(value.substring(comma + 1), 10);
    if (comma === -1 || !/^\d+$/.test(value.substring(comma + 1))) {
        throw fail(com, key, `${key}=${value}: expected <sprite>,<index>`);
    }
    const shape = getSpriteShape(name);
    if (!shape) {
        throw fail(com, key, `${key}=${value}: no sprite named ${name} (base content/sprites or a mod's sprites/)`);
    }
    if (index >= shape.tiles) {
        throw fail(com, key, `${key}=${value}: sprite ${name} has ${shape.tiles} tile(s) (0 to ${shape.tiles - 1})`);
    }
}

function checkComponent(def: IfDef, com: IfComponent, isRoot: boolean) {
    const where = isRoot ? def.name : `${def.name}:${com.name}`;
    const type = com.props.get('type');
    if (isRoot) {
        if (type !== undefined && type !== 'layer' && type !== 'overlay') {
            throw fail(com, 'type', `${where}: interface type must be layer or overlay (got ${type})`);
        }
    } else if (type === undefined) {
        throw fail(com, null, `${where}: type= is required (${COMPONENT_TYPES.join(', ')})`);
    } else if (!COMPONENT_TYPES.includes(type)) {
        throw fail(com, 'type', `${where}: unknown type ${type} (${COMPONENT_TYPES.join(', ')})`);
    }

    // scriptN and scriptNopM must be numbered from 1 without gaps (the packer
    // counts them and then reads 1..count)
    const contiguous = (prefix: string, max: number) => {
        let seen = 0;
        for (let i = 1; i <= max; i++) {
            if (com.props.has(`${prefix}${i}`)) {
                if (seen !== i - 1) {
                    throw fail(com, `${prefix}${i}`, `${where}: ${prefix}${i} is set but ${prefix}${seen + 1} is not (number them from 1 without gaps)`);
                }
                seen = i;
            }
        }
    };
    contiguous('script', 5);
    for (let j = 1; j <= 5; j++) {
        contiguous(`script${j}op`, 20);
    }

    // a layer chain must not loop back (the client would recurse forever)
    const seen = new Set<IfComponent>([com]);
    for (let parent = com.props.get('layer'); parent !== undefined; ) {
        const layer = def.byName.get(parent);
        if (!layer) {
            break;
        }
        if (seen.has(layer)) {
            throw fail(com, 'layer', `${where}: layer=${com.props.get('layer')} makes a loop of layers`);
        }
        seen.add(layer);
        parent = layer.props.get('layer');
    }

    for (const [key, value] of com.props) {
        // only what mods set (base values of a patched base component are trusted)
        if (!com.origins.has(key)) {
            continue;
        }
        const bad = (expected: string) => fail(com, key, `${where}: invalid ${key}=${value} (${expected})`);

        if (key === 'type') {
            continue;
        } else if (key === 'y' && Y_END.test(value)) {
            continue; // resolved already
        } else if (INTS.includes(key)) {
            if (!NUMBER.test(value)) {
                throw bad('expected a number');
            }
            if (key === 'trans' && (parseInt(value) < 0 || parseInt(value) > 255)) {
                throw bad('0 to 255');
            }
        } else if (COLOURS.includes(key)) {
            if (!NUMBER.test(value)) {
                throw bad('expected a colour like 0xff981f');
            }
        } else if (YES_NO.includes(key)) {
            if (value !== 'yes' && value !== 'no') {
                throw bad('expected yes or no');
            }
        } else if (key === 'buttontype') {
            if (!BUTTON_TYPES.includes(value)) {
                throw bad(BUTTON_TYPES.join(', '));
            }
        } else if (key === 'font') {
            if (!FONTS.includes(value)) {
                throw bad(FONTS.join(', '));
            }
        } else if (key === 'margin') {
            if (!/^-?\d+,-?\d+$/.test(value)) {
                throw bad('expected x,y');
            }
        } else if (key === 'layer' || key === 'overlayer') {
            if (isRoot) {
                throw bad('only components have a parent layer');
            }
            const target = def.byName.get(value);
            if (!target) {
                throw bad(`no component [${value}] in ${def.name}`);
            }
            if (target === com) {
                throw bad('a component cannot be its own layer');
            }
            if (def.placeholders.includes(value)) {
                throw bad(`[${value}] is left out of this version of ${def.name}`);
            }
            if (key === 'layer' && target.props.get('type') !== 'layer') {
                throw bad(`[${value}] is not type=layer`);
            }
        } else if (key === 'graphic' || key === 'activegraphic') {
            if (value.length > 0) {
                checkSprite(com, key, value);
            }
        } else if (/^slot\d+$/.test(key)) {
            const [sprite, offset] = value.split(':');
            if (offset !== undefined && !/^-?\d+,-?\d+$/.test(offset)) {
                throw bad('expected <sprite>,<index> or <sprite>,<index>:x,y');
            }
            checkSprite(com, key, sprite);
        } else if (key === 'model' || key === 'activemodel') {
            if (ModelPack.getByName(value) === -1) {
                throw bad('no model with that name');
            }
        } else if (key === 'anim' || key === 'activeanim') {
            if (SeqPack.getByName(value) === -1) {
                throw bad('no seq with that name');
            }
        } else if (key === 'actiontarget') {
            if (!value.split(',').every(t => ACTION_TARGETS.includes(t))) {
                throw bad(`comma-separated ${ACTION_TARGETS.join(', ')}`);
            }
        } else if (/^script\dop\d+$/.test(key)) {
            checkScriptOp(value, bad);
        } else if (/^script\d$/.test(key)) {
            const [comparator, operand, extra] = value.split(',');
            if (!COMPARATORS.includes(comparator) || operand === undefined || !NUMBER.test(operand) || extra !== undefined) {
                throw bad(`expected <${COMPARATORS.join('|')}>,<number>`);
            }
        }
        // text, activetext, option, optionN, actionverb, action: any text
    }
}

function checkScriptOp(value: string, bad: (expected: string) => Error) {
    if (value === '') {
        return;
    }
    const [op, ...args] = value.split(',');
    const argc = (n: number) => {
        if (args.length !== n) {
            throw bad(`${op} takes ${n} argument(s)`);
        }
    };
    switch (op) {
        case 'stat_level':
        case 'stat_base_level':
        case 'stat_xp':
        case 'stat_xp_remaining':
            argc(1);
            if (!STATS.includes(args[0])) {
                throw bad(`unknown stat ${args[0]}`);
            }
            break;
        case 'inv_count':
        case 'inv_contains':
            argc(2);
            if (InterfacePack.getByName(args[0]) === -1 || !args[0].includes(':')) {
                throw bad(`no component ${args[0]} (use interface:component)`);
            }
            if (ObjPack.getByName(args[1]) === -1) {
                throw bad(`no obj ${args[1]}`);
            }
            break;
        case 'pushvar':
            argc(1);
            if (VarpPack.getByName(args[0]) === -1) {
                throw bad(`no varp ${args[0]}`);
            }
            break;
        case 'testbit':
            argc(2);
            if (VarpPack.getByName(args[0]) === -1) {
                throw bad(`no varp ${args[0]}`);
            }
            if (!/^\d+$/.test(args[1])) {
                throw bad('testbit takes <varp>,<bit>');
            }
            break;
        case 'op7':
        case 'op8':
        case 'op9':
        case 'runenergy':
        case 'runweight':
            argc(0);
            break;
        default:
            throw bad('unknown script op');
    }
}

// ----------------------------------------------------------------------------

// The effective source of an interface, in the format the packer reads
function serialize(def: IfDef): string {
    const out: string[] = [];
    for (const [key, value] of def.root.props) {
        out.push(`${key}=${value}`);
    }
    for (const com of def.components) {
        out.push('', `[${com.name}]`);
        for (const [key, value] of com.props) {
            out.push(`${key}=${value}`);
        }
    }
    return out.join('\n') + '\n';
}

// A base component that a replacement leaves out keeps its id and symbol
// (base scripts may still use it) as an empty, hidden layer that draws nothing
function placeholder(name: string): IfComponent {
    const com = newComponent(name, null);
    for (const [key, value] of [
        ['type', 'layer'],
        ['x', '0'],
        ['y', '0'],
        ['width', '0'],
        ['height', '0'],
        ['scroll', '0'],
        ['hide', 'yes']
    ]) {
        com.props.set(key, value);
    }
    return com;
}

const capability: ModCapability = {
    name: 'interfaces',

    afterRevalidate() {
        const root = ModManager.stagingDir('interfaces');
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });

        // .if files belong in interfaces/, not with scripts or configs
        for (const dir of ['scripts', 'config']) {
            const misplaced = ModManager.listFiles(dir, ['.if', '.ifpatch']);
            if (misplaced.length > 0) {
                throw ModManager.error(misplaced[0], null, 'interface files go in the interfaces/ folder of the mod');
            }
        }

        const wholeFiles = ModManager.listFiles('interfaces', '.if');
        const patchFiles = ModManager.listFiles('interfaces', '.ifpatch');
        if (wholeFiles.length === 0 && patchFiles.length === 0) {
            return;
        }
        ModManager.markTouched('.if');

        const baseFiles = new Map<string, string>();
        for (const file of listFilesExt(`${Environment.BUILD_SRC_DIR}/scripts`, '.if')) {
            baseFiles.set(path.basename(file, '.if'), file);
        }

        for (const file of [...wholeFiles, ...patchFiles]) {
            if (!INTERFACE_NAME.test(file.name)) {
                throw ModManager.error(file, null, `invalid interface name '${file.name}': use lower-case letters, digits and _`);
            }
        }

        // 1. whole files: the last mod in load order wins
        const defs = new Map<string, IfDef>();
        const versions = new Map<string, { file: ModFile; parsed: ReturnType<typeof parseModFile> }[]>();
        for (const file of wholeFiles) {
            const previous = ModManager.claim('interface', file.name, file);
            if (previous && previous.mod === file.mod) {
                throw ModManager.error(file, null, `interface ${file.name} is also defined by ${previous.relPath}`);
            }
            const list = versions.get(file.name) ?? [];
            list.push({ file, parsed: parseModFile(file) });
            versions.set(file.name, list);
        }
        for (const [name, list] of versions) {
            const { file, parsed } = list[list.length - 1];
            const def = newDef(name, file);
            def.root.origin = { file, line: 1 };
            def.root.touched = true;
            applySections(def, file, parsed, false);

            // Components of the replaced versions (base content, earlier
            // mods) that this one leaves out keep their ids and symbols.
            // Interface properties it does not set (type=overlay changes how
            // the server runs its button scripts) are kept too.
            const replaced: string[] = [];
            const inherited = new Map<string, string>();
            const baseFile = baseFiles.get(name);
            if (baseFile) {
                printInfo(`[mods] ${file.mod.name} replaces base interface ${name}`);
                const baseDef = parseBaseFile(name, baseFile);
                replaced.push(...baseDef.components.map(com => com.name));
                baseDef.root.props.forEach((value, key) => inherited.set(key, value));
            }
            for (const earlier of list.slice(0, -1)) {
                replaced.push(...earlier.parsed.sections.map(section => section.name));
                earlier.parsed.root.props.forEach(prop => inherited.set(prop.key, prop.value));
            }
            for (const [key, value] of inherited) {
                if (!def.root.props.has(key)) {
                    def.root.props.set(key, value);
                }
            }
            for (const comName of replaced) {
                if (!def.byName.has(comName)) {
                    const com = placeholder(comName);
                    def.placeholders.push(comName);
                    def.components.push(com);
                    def.byName.set(comName, com);
                }
            }
            if (def.placeholders.length > 0) {
                printWarning(
                    `[mods] ${file.mod.name} (${file.relPath}) leaves out ${def.placeholders.length} component(s) of the ${name} it replaces; they stay as empty hidden layers so scripts that use them still compile: ${def.placeholders.join(', ')}`
                );
            }
            defs.set(name, def);
        }

        // 2. patches, in load order, on top of the result
        for (const file of patchFiles) {
            let def = defs.get(file.name);
            if (!def) {
                const baseFile = baseFiles.get(file.name);
                if (!baseFile) {
                    throw ModManager.error(file, null, `there is no interface named ${file.name} to patch (base content or a mod's interfaces/${file.name}.if)`);
                }
                def = parseBaseFile(file.name, baseFile);
                defs.set(file.name, def);
            }
            applySections(def, file, parseModFile(file), true);
        }

        // 3. ids: existing names keep theirs, new names get stable ids after base content
        for (const def of defs.values()) {
            ModManager.registerName('interface', InterfacePack, def.name);
            for (const com of def.components) {
                ModManager.registerName('interface', InterfacePack, `${def.name}:${com.name}`);
            }
        }
        // ids are u16 and 65535 marks a new interface in the client archive;
        // layer/model references are stored as (id + 0x100) in two bytes
        if (InterfacePack.max > 0xff00) {
            throw new Error(`[mods] too many interface components: ${InterfacePack.max} (the cache format allows 65280)`);
        }

        // 4. validate what mods wrote, then stage the effective sources
        for (const def of defs.values()) {
            if (def.root.touched) {
                checkComponent(def, def.root, true);
            }
            for (const com of def.components) {
                if (com.touched) {
                    checkComponent(def, com, false);
                }
            }

            const staged = path.join(root, `${def.name}.if`);
            fs.writeFileSync(staged, serialize(def), 'latin1');
            ModManager.setAsset('interface', def.name, staged);
        }
    }
};

export default capability;
