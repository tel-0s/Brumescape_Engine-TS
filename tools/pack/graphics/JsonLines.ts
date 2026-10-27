// Strict JSON parser that remembers the line of every object and array, so
// authoring errors in mod JSON files can name a line (JSON.parse cannot).

export class JsonSyntaxError extends Error {
    readonly line: number;

    constructor(message: string, line: number) {
        super(message);
        this.line = line;
    }
}

export interface JsonDocument {
    value: unknown;
    // line (1-based) where each object or array starts
    lines: WeakMap<object, number>;
}

export function parseJsonWithLines(text: string): JsonDocument {
    const lines = new WeakMap<object, number>();
    let pos = 0;
    let line = 1;

    if (text.charCodeAt(0) === 0xfeff) {
        pos = 1;
    }

    function fail(message: string): never {
        throw new JsonSyntaxError(message, line);
    }

    function skip() {
        while (pos < text.length) {
            const ch = text[pos];
            if (ch === '\n') {
                line++;
                pos++;
            } else if (ch === ' ' || ch === '\t' || ch === '\r') {
                pos++;
            } else {
                break;
            }
        }
    }

    function value(): unknown {
        skip();
        const ch = text[pos];
        if (ch === '{') {
            return object();
        } else if (ch === '[') {
            return array();
        } else if (ch === '"') {
            return string();
        } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
            return number();
        } else if (text.startsWith('true', pos)) {
            pos += 4;
            return true;
        } else if (text.startsWith('false', pos)) {
            pos += 5;
            return false;
        } else if (text.startsWith('null', pos)) {
            pos += 4;
            return null;
        } else if (pos >= text.length) {
            fail('unexpected end of file');
        }
        fail(`unexpected character '${ch}'`);
    }

    function object(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        lines.set(out, line);
        pos++;
        skip();
        if (text[pos] === '}') {
            pos++;
            return out;
        }
        for (;;) {
            skip();
            if (text[pos] !== '"') {
                fail('expected a "key" in double quotes');
            }
            const key = string();
            skip();
            if (text[pos] !== ':') {
                fail(`expected ':' after "${key}"`);
            }
            pos++;
            if (Object.prototype.hasOwnProperty.call(out, key)) {
                fail(`"${key}" appears twice in one object`);
            }
            out[key] = value();
            skip();
            if (text[pos] === ',') {
                pos++;
                skip();
                if (text[pos] === '}') {
                    fail('trailing comma before }');
                }
                continue;
            }
            if (text[pos] === '}') {
                pos++;
                return out;
            }
            fail("expected ',' or '}'");
        }
    }

    function array(): unknown[] {
        const out: unknown[] = [];
        lines.set(out, line);
        pos++;
        skip();
        if (text[pos] === ']') {
            pos++;
            return out;
        }
        for (;;) {
            out.push(value());
            skip();
            if (text[pos] === ',') {
                pos++;
                skip();
                if (text[pos] === ']') {
                    fail('trailing comma before ]');
                }
                continue;
            }
            if (text[pos] === ']') {
                pos++;
                return out;
            }
            fail("expected ',' or ']'");
        }
    }

    function string(): string {
        const start = pos;
        pos++;
        while (pos < text.length && text[pos] !== '"') {
            if (text[pos] === '\\') {
                pos++;
            } else if (text[pos] === '\n') {
                fail('line break inside a string');
            }
            pos++;
        }
        if (pos >= text.length) {
            fail('unterminated string');
        }
        pos++;
        try {
            return JSON.parse(text.substring(start, pos)) as string;
        } catch {
            fail('invalid escape in string');
        }
    }

    function number(): number {
        const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.substring(pos, pos + 64));
        if (!match) {
            fail('invalid number');
        }
        pos += match[0].length;
        return Number(match[0]);
    }

    const result = value();
    skip();
    if (pos < text.length) {
        fail('unexpected text after the end of the JSON value');
    }
    return { value: result, lines };
}
