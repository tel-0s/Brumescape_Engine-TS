// Structural reader for the synth ("sounds.dat") wave format. It mirrors the
// client decoder (Brumescape_Client-TS: sound/Wave.ts, Tone.ts, Envelope.ts)
// but only walks the bytes, so the mod loader can reject a broken .synth file
// at build time instead of crashing the client, and so tests can decode the
// packed sounds archive.
//
// A .synth file is exactly one wave:
//   10 x tone slot: u8 0 (empty), or a tone (below; the first byte is the
//                   first byte of the tone's frequency envelope)
//   u16 loopBegin, u16 loopEnd
// tone:
//   envelope frequencyBase, envelope amplitudeBase
//   [u8 != 0 -> envelope frequencyModRate, envelope frequencyModRange]   (else u8 0)
//   [u8 != 0 -> envelope amplitudeModRate, envelope amplitudeModRange]   (else u8 0)
//   [u8 != 0 -> envelope release, envelope attack]                      (else u8 0)
//   up to 10 x (smarts volume, smart semitone, smarts delay), ended by volume 0
//   smarts reverbDelay, smarts reverbVolume, u16 length, u16 start
// envelope: u8 form, i32 start, i32 end, u8 n, n x (u16 delta, u16 peak)

class Reader {
    pos = 0;

    constructor(readonly data: Uint8Array) {}

    private need(n: number) {
        if (this.pos + n > this.data.length) {
            throw new Error(`unexpected end of data at byte ${this.pos}`);
        }
    }

    u1(): number {
        this.need(1);
        return this.data[this.pos++];
    }

    peek(): number {
        this.need(1);
        return this.data[this.pos];
    }

    skip(n: number) {
        this.need(n);
        this.pos += n;
    }

    // g1 < 128 ? 1 byte : 2 bytes (gsmart and gsmarts have the same widths)
    smart() {
        this.skip(this.peek() < 0x80 ? 1 : 2);
    }

    // gsmarts: the value
    smarts(): number {
        if (this.peek() < 0x80) {
            return this.u1();
        }
        const value = (this.u1() << 8) | this.u1();
        return value - 0x8000;
    }
}

function envelope(r: Reader) {
    r.skip(1 + 4 + 4);
    const n = r.u1();
    r.skip(n * 4);
}

function tone(r: Reader) {
    envelope(r);
    envelope(r);
    for (let i = 0; i < 3; i++) {
        if (r.peek() !== 0) {
            envelope(r);
            envelope(r);
        } else {
            r.skip(1);
        }
    }
    // the client calls g1() for each of the three optional pairs, then rewinds
    // when it is non-zero; the harmonics follow
    for (let i = 0; i < 10; i++) {
        const volume = r.smarts();
        if (volume === 0) {
            break;
        }
        r.smart();
        r.smart();
    }
    r.smart();
    r.smart();
    r.skip(4);
}

// Reads one wave starting at `offset` and returns the offset after it.
// Throws a plain Error (without file attribution) when the bytes are not a wave.
export function measureSynth(data: Uint8Array, offset = 0): number {
    const r = new Reader(data);
    r.pos = offset;
    let tones = 0;
    for (let i = 0; i < 10; i++) {
        if (r.peek() !== 0) {
            tone(r);
            tones++;
        } else {
            r.skip(1);
        }
    }
    r.skip(4);
    if (tones === 0) {
        throw new Error('the wave has no tones');
    }
    return r.pos;
}

// Validates a whole .synth file (one wave, no trailing bytes).
export function validateSynthFile(data: Uint8Array) {
    if (data.length === 0) {
        throw new Error('the file is empty');
    }
    const end = measureSynth(data);
    if (end !== data.length) {
        throw new Error(`the wave ends at byte ${end} but the file has ${data.length} bytes`);
    }
}

// Splits the packed sounds.dat (u16 id + wave, repeated, ended by id 65535)
export function readSoundsDat(data: Uint8Array): Map<number, Uint8Array> {
    const out = new Map<number, Uint8Array>();
    let pos = 0;
    for (;;) {
        if (pos + 2 > data.length) {
            throw new Error('sounds.dat has no 65535 terminator');
        }
        const id = (data[pos] << 8) | data[pos + 1];
        pos += 2;
        if (id === 65535) {
            return out;
        }
        const end = measureSynth(data, pos);
        out.set(id, data.subarray(pos, end));
        pos = end;
    }
}
