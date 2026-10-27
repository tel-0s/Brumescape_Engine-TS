// Light-weight reading of RuneScript (.rs2) source text for the mod loader:
// script blocks with their raw line numbers, signatures, label jumps and
// name references. It has no packer or engine imports.
//
// Comments are handled exactly like loadFileFull (tools/pack/Parse.ts), which
// builds the base script names (crawlConfigNames). So a header inside a
// /* ... */ comment is not a block here either.

// One [trigger,subject] block of a script file
export interface ScriptBlock {
    // '[trigger,subject]'
    name: string;
    trigger: string;
    subject: string;
    // 0-based index of the header line in the file
    line: number;
    // 0-based index of the first line after the block (the next header, or the line count)
    end: number;
    // The header line's text after ']': the signature, and on some scripts the first statement
    rest: string;
}

export interface ScriptSignature {
    // parameter types, e.g. ['int', 'namedobj']
    params: string[];
    // return types, or [] when the script returns nothing
    returns: string[];
}

export interface CodeLine {
    // 0-based line index in the file
    index: number;
    // the line without comments, trimmed
    text: string;
}

export function splitSourceLines(text: string): string[] {
    return text.replace(/\r/g, '').split('\n');
}

// The non-empty lines of a source file with comments removed, keeping their
// line indices. Same rules as loadFileFull in tools/pack/Parse.ts.
export function codeLines(lines: string[]): CodeLine[] {
    const out: CodeLine[] = [];
    let multiLineComments = 0;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (multiLineComments > 0) {
            let commentStart = line.indexOf('/*');
            while (commentStart !== -1) {
                line = line.substring(commentStart + 2).trimStart();
                multiLineComments++;
                commentStart = line.indexOf('/*');
            }

            let commentEnd = line.indexOf('*/');
            while (commentEnd !== -1 && multiLineComments > 0) {
                line = line.substring(commentEnd + 2).trimStart();
                multiLineComments--;
                commentEnd = line.indexOf('*/');
            }

            if (multiLineComments > 0) {
                continue;
            }
        }

        if (line.length === 0) {
            continue;
        }

        const comment = line.indexOf('//');
        if (comment !== -1) {
            line = line.substring(0, comment).trimEnd();
            if (line.length === 0) {
                continue;
            }
        }

        const commentStart = line.indexOf('/*');
        const commentEnd = line.indexOf('*/');
        if (commentStart !== -1) {
            if (commentEnd !== -1) {
                line = line.substring(0, commentStart) + line.substring(commentEnd + 2);
            } else {
                line = line.substring(0, commentStart);
                multiLineComments++;
            }

            if (line.length === 0) {
                continue;
            }
        }

        out.push({ index: i, text: line });
    }

    return out;
}

// Every [trigger,subject] block of a source file, in file order
export function scanScriptBlocks(lines: string[]): ScriptBlock[] {
    const blocks: ScriptBlock[] = [];

    for (const { index, text } of codeLines(lines)) {
        if (!text.startsWith('[')) {
            continue;
        }

        const close = text.indexOf(']');
        if (close === -1) {
            continue;
        }

        const name = text.substring(0, close + 1);
        const inner = name.substring(1, name.length - 1);
        const comma = inner.indexOf(',');
        const raw = lines[index];
        const at = raw.indexOf(name);

        if (blocks.length > 0) {
            blocks[blocks.length - 1].end = index;
        }

        blocks.push({
            name,
            trigger: comma === -1 ? inner : inner.substring(0, comma),
            subject: comma === -1 ? '' : inner.substring(comma + 1),
            line: index,
            end: lines.length,
            rest: at === -1 ? text.substring(close + 1) : raw.substring(at + name.length)
        });
    }

    return blocks;
}

// Replace the [trigger,subject] of a header line, keeping the rest of the line
// (signature, inline statement, comment) and its column positions after it.
export function renameHeader(line: string, newName: string): string {
    const open = line.indexOf('[');
    const close = line.indexOf(']', open);
    if (open === -1 || close === -1) {
        throw new Error(`Not a script header: ${line}`);
    }
    return line.substring(0, open) + newName + line.substring(close + 1);
}

// Read a balanced (...) group at `from`; returns its inner text and the index after it
function readGroup(text: string, from: number): { inner: string; next: number } | null {
    if (text[from] !== '(') {
        return null;
    }
    let depth = 0;
    for (let i = from; i < text.length; i++) {
        if (text[i] === '(') {
            depth++;
        } else if (text[i] === ')') {
            depth--;
            if (depth === 0) {
                return { inner: text.substring(from + 1, i), next: i + 1 };
            }
        }
    }
    return null;
}

// The parameter and return types of a block, from the text after its header
// name: '(int $a, obj $b)(int)' -> { params: ['int', 'obj'], returns: ['int'] }.
// Whitespace between ']' and '(' is not part of a signature (a statement can
// follow the header on the same line).
export function parseSignature(rest: string): ScriptSignature {
    const params = readGroup(rest, 0);
    if (!params) {
        return { params: [], returns: [] };
    }
    const returns = readGroup(rest, params.next);
    const types = (inner: string) =>
        inner
            .split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0)
            .map(p => p.split(/\s+/)[0]);
    return { params: types(params.inner), returns: returns ? types(returns.inner) : [] };
}

export function formatSignature(signature: ScriptSignature): string {
    return `(${signature.params.join(', ')})${signature.returns.length > 0 ? `(${signature.returns.join(', ')})` : ''}`;
}

export function sameSignature(a: ScriptSignature, b: ScriptSignature): boolean {
    return a.params.join(',') === b.params.join(',') && a.returns.join(',') === b.returns.join(',');
}

// Characters that can continue a script name after a reference like ~name or @name
const NAME_CHAR = /[A-Za-z0-9_:.]/;

// Lines (0-based) of a block's body with a label jump (@label), ignoring
// comments and string literals. A proc cannot jump to labels.
export function findLabelJumps(lines: string[], block: ScriptBlock): number[] {
    const found: number[] = [];
    let inBlockComment = false;

    for (let i = block.line; i < block.end; i++) {
        const line = i === block.line ? block.rest : lines[i];
        let inString = false;
        for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            if (inBlockComment) {
                if (ch === '*' && line[c + 1] === '/') {
                    inBlockComment = false;
                    c++;
                }
                continue;
            }
            if (inString) {
                if (ch === '\\') {
                    c++;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
            } else if (ch === '/' && line[c + 1] === '/') {
                break;
            } else if (ch === '/' && line[c + 1] === '*') {
                inBlockComment = true;
                c++;
            } else if (ch === '@' && /[A-Za-z_]/.test(line[c + 1] ?? '')) {
                found.push(i);
                break;
            }
        }
    }

    return found;
}

// References to `name` as ~name (proc call) or @name (label jump) in code
// lines (comments removed). Returns the 0-based line and the sigil of each.
export function findReferences(lines: string[], name: string): { index: number; sigil: '~' | '@' }[] {
    const found: { index: number; sigil: '~' | '@' }[] = [];
    for (const { index, text } of codeLines(lines)) {
        let from = 0;
        while (true) {
            const at = text.indexOf(name, from);
            if (at === -1) {
                break;
            }
            from = at + name.length;
            const sigil = text[at - 1];
            if ((sigil !== '~' && sigil !== '@') || NAME_CHAR.test(text[at + name.length] ?? '')) {
                continue;
            }
            found.push({ index, sigil });
        }
    }
    return found;
}

// Replace every ~from / @from reference with ~to / @to. Applies to raw lines
// (comments included, which is harmless). Returns the number of replacements.
export function replaceReferences(lines: string[], from: string, to: string): number {
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let pos = 0;
        while (true) {
            const at = line.indexOf(from, pos);
            if (at === -1) {
                break;
            }
            const sigil = line[at - 1];
            const after = line[at + from.length] ?? '';
            if ((sigil === '~' || sigil === '@') && !NAME_CHAR.test(after)) {
                line = line.substring(0, at) + to + line.substring(at + from.length);
                pos = at + to.length;
                count++;
            } else {
                pos = at + from.length;
            }
        }
        lines[i] = line;
    }
    return count;
}

// Every ~name / @name whose name starts with `prefix`, in code lines
export function findPrefixedReferences(lines: string[], prefix: string): { index: number; sigil: '~' | '@'; name: string }[] {
    const found: { index: number; sigil: '~' | '@'; name: string }[] = [];
    for (const { index, text } of codeLines(lines)) {
        let from = 0;
        while (true) {
            const at = text.indexOf(prefix, from);
            if (at === -1) {
                break;
            }
            let end = at + prefix.length;
            while (end < text.length && NAME_CHAR.test(text[end])) {
                end++;
            }
            from = end;
            const sigil = text[at - 1];
            if (sigil !== '~' && sigil !== '@') {
                continue;
            }
            found.push({ index, sigil, name: text.substring(at, end) });
        }
    }
    return found;
}
