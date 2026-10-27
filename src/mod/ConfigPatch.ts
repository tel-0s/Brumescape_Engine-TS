// Partial config patches: config/patch/**/*.<type> in a mod.
//
// A patch block changes some properties of a config that base content or an
// earlier mod defines, and keeps the rest:
//
//   [man]
//   name=Bob              set: replaces every 'name' line (in place)
//   op3=Pickpocket        numbered keys are separate keys: only op3 changes
//   param=quest_npc,1     list key: replaces the entry with the same sub-key (param name), or adds it
//   -op2                  remove every 'op2' line
//   -param=stabdefence    remove one entry of a list key, by sub-key
//   +val=extra_value      append a line, never replace
//
// Values go through the same parser as base content (constants, validation).
// See MODDING.md ("Config patches") for the full rules.

import ScriptVarType from '#/cache/config/ScriptVarType.js';
import { ParamPack } from '#tools/pack/PackFile.js';
import { CONSTANTS, parseConfigLines } from '#tools/pack/config/PackShared.js';
import type { ConfigLine, ConfigParseCallback, ConfigValue, ParamValue } from '#tools/pack/config/PackShared.js';

export type PatchOp = { kind: 'set' | 'append'; line: number; key: string; value: ConfigValue } | { kind: 'remove'; line: number; key: string; subKey: string | null };

export interface PatchBlock {
    name: string;
    // 1-based
    line: number;
    ops: PatchOp[];
}

// Thrown by parsePatch/applyPatch with a 1-based line; the caller adds the file
export class PatchError extends Error {
    constructor(
        readonly line: number,
        message: string
    ) {
        super(message);
    }
}

function beforeComma(value: string): string {
    const comma = value.indexOf(',');
    return comma === -1 ? value : value.substring(0, comma);
}

function substituteConstant(value: string): string {
    if (value.startsWith('^') && CONSTANTS.has(value.substring(1))) {
        return CONSTANTS.get(value.substring(1))!;
    }
    return value;
}

// Keys that hold a list whose entries are identified by a sub-key: the part of
// the value before the first comma (for param: the param name).
//   param   (npc, obj, loc, struct, ...)  param=<param>,<value>
//   val     (enum, unless inputtype=autoint)  val=<key>,<value>
//   data    (dbrow)    data=<column>,<values...>
//   column  (dbtable)  column=<name>,<types...>
export function isSubKeyed(extension: string, key: string, config: ConfigLine[]): boolean {
    if (key === 'param') {
        return true;
    }
    if (extension === '.enum' && key === 'val') {
        const inputtype = config.find(l => l.key === 'inputtype');
        return !inputtype || inputtype.value !== ScriptVarType.AUTOINT;
    }
    return (extension === '.dbrow' && key === 'data') || (extension === '.dbtable' && key === 'column');
}

// The sub-key of a parsed config line of a sub-keyed key
function subKeyOf(key: string, value: ConfigValue): string {
    if (key === 'param' && typeof value === 'object' && value !== null && 'id' in value) {
        return ParamPack.getById((value as ParamValue).id);
    }
    return beforeComma(String(value));
}

function isPropertyLine(line: string): boolean {
    return line.length > 0 && !line.startsWith('//') && !line.startsWith('[');
}

// Parse a patch file. Set/append values are parsed by the base parser for the
// type (constants are substituted, values validated).
export function parsePatch(lines: string[], parse: ConfigParseCallback): PatchBlock[] {
    const blocks: PatchBlock[] = [];
    // per header line: the set/append ops waiting for their parsed values
    const pending = new Map<number, Extract<PatchOp, { kind: 'set' | 'append' }>[]>();
    const forParser: string[] = [];
    let current: PatchBlock | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        if (line.startsWith('[')) {
            if (!line.endsWith(']') || line.length < 3) {
                throw new PatchError(lineNumber, `Invalid patch header: ${line}`);
            }
            current = { name: line.substring(1, line.length - 1), line: lineNumber, ops: [] };
            blocks.push(current);
            pending.set(lineNumber, []);
            forParser.push(line);
            continue;
        }

        if (!isPropertyLine(line)) {
            forParser.push(line);
            continue;
        }

        if (!current) {
            throw new PatchError(lineNumber, `Property outside of a [config] block: ${line}`);
        }

        if (line.startsWith('-')) {
            const body = line.substring(1);
            const eq = body.indexOf('=');
            const key = eq === -1 ? body : body.substring(0, eq);
            const subKey = eq === -1 ? null : substituteConstant(body.substring(eq + 1));
            if (!/^[A-Za-z0-9_]+$/.test(key)) {
                throw new PatchError(lineNumber, `Invalid property to remove: ${line}`);
            }
            if (subKey !== null && subKey.length === 0) {
                throw new PatchError(lineNumber, `Missing sub-key after '=': ${line} (use -${key} to remove every ${key} line)`);
            }
            current.ops.push({ kind: 'remove', line: lineNumber, key, subKey });
            forParser.push('');
            continue;
        }

        const append = line.startsWith('+');
        const text = append ? line.substring(1) : line;
        const eq = text.indexOf('=');
        if (eq === -1) {
            throw new PatchError(lineNumber, `Missing property separator: ${line}`);
        }
        const op = { kind: append ? 'append' : 'set', line: lineNumber, key: text.substring(0, eq), value: '' } as Extract<PatchOp, { kind: 'set' | 'append' }>;
        current.ops.push(op);
        pending.get(current.line)!.push(op);
        forParser.push(text);
    }

    // The shared parser checks keys and values exactly like base content
    parseConfigLines(forParser, parse, [], {
        error: (line, message) => new PatchError(line, message),
        onConfig: (_name, config, headerLine) => {
            const ops = pending.get(headerLine)!;
            if (ops.length !== config.length) {
                throw new PatchError(headerLine, 'Internal error: patch lines and parsed lines do not match');
            }
            for (let i = 0; i < ops.length; i++) {
                ops[i].value = config[i].value;
            }
        }
    });

    return blocks;
}

// Apply one patch block to a config (in place). Returns a short summary of
// the changes for the build log, and warnings (removals that matched nothing).
export function applyPatch(extension: string, config: ConfigLine[], block: PatchBlock): { summary: string[]; warnings: { line: number; message: string }[] } {
    const summary: string[] = [];
    const warnings: { line: number; message: string }[] = [];
    // keys already replaced by a 'set' in this block: later sets of the same key add to it
    const replaced = new Set<string>();

    const lastIndexOf = (key: string) => {
        for (let i = config.length - 1; i >= 0; i--) {
            if (config[i].key === key) {
                return i;
            }
        }
        return -1;
    };

    for (const op of block.ops) {
        if (op.kind === 'remove') {
            if (op.subKey !== null && !isSubKeyed(extension, op.key, config)) {
                throw new PatchError(op.line, `${op.key} is not a list with sub-keys in ${extension} configs; use -${op.key} to remove it`);
            }
            const before = config.length;
            for (let i = config.length - 1; i >= 0; i--) {
                if (config[i].key === op.key && (op.subKey === null || subKeyOf(op.key, config[i].value) === op.subKey)) {
                    config.splice(i, 1);
                }
            }
            if (config.length === before) {
                warnings.push({ line: op.line, message: `[${block.name}] has no ${op.key}${op.subKey !== null ? ` with sub-key ${op.subKey}` : ''} to remove` });
            }
            summary.push(`-${op.key}${op.subKey !== null ? `=${op.subKey}` : ''}`);
            continue;
        }

        const line: ConfigLine = { key: op.key, value: op.value };

        if (op.kind === 'append') {
            const last = lastIndexOf(op.key);
            config.splice(last === -1 ? config.length : last + 1, 0, line);
            summary.push(`+${op.key}`);
            continue;
        }

        if (isSubKeyed(extension, op.key, config)) {
            const subKey = subKeyOf(op.key, op.value);
            const matches = config.map((l, i) => (l.key === op.key && subKeyOf(l.key, l.value) === subKey ? i : -1)).filter(i => i !== -1);
            if (matches.length > 0) {
                config[matches[0]] = line;
                for (let i = matches.length - 1; i > 0; i--) {
                    config.splice(matches[i], 1);
                }
            } else {
                const last = lastIndexOf(op.key);
                config.splice(last === -1 ? config.length : last + 1, 0, line);
            }
            summary.push(`${op.key}=${subKey}`);
            continue;
        }

        if (replaced.has(op.key)) {
            // a second value for the same key in one block: keep both
            config.splice(lastIndexOf(op.key) + 1, 0, line);
            continue;
        }
        replaced.add(op.key);

        const first = config.findIndex(l => l.key === op.key);
        if (first === -1) {
            config.push(line);
        } else {
            config[first] = line;
            for (let i = config.length - 1; i > first; i--) {
                if (config[i].key === op.key) {
                    config.splice(i, 1);
                }
            }
        }
        summary.push(op.key);
    }

    return { summary, warnings };
}
