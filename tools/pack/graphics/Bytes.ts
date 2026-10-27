// A small growable byte writer for the model and animation encoders
// (Packet.alloc buffers have a fixed size).
export class ByteWriter {
    private buf: Uint8Array = new Uint8Array(256);
    length: number = 0;

    private ensure(extra: number) {
        if (this.length + extra <= this.buf.length) {
            return;
        }
        let size = this.buf.length * 2;
        while (size < this.length + extra) {
            size *= 2;
        }
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
    }

    p1(value: number) {
        this.ensure(1);
        this.buf[this.length++] = value & 0xff;
    }

    p2(value: number) {
        this.ensure(2);
        this.buf[this.length++] = (value >> 8) & 0xff;
        this.buf[this.length++] = value & 0xff;
    }

    // Signed smart, read by Packet.gsmart(): 1 byte for -64..63, else 2 bytes for -16384..16383
    psmarts(value: number) {
        if (value >= -64 && value < 64) {
            this.p1(value + 64);
        } else if (value >= -16384 && value < 16384) {
            this.p2(value + 0xc000);
        } else {
            throw new RangeError(`value ${value} is out of range (-16384..16383)`);
        }
    }

    pdata(data: Uint8Array) {
        this.ensure(data.length);
        this.buf.set(data, this.length);
        this.length += data.length;
    }

    toBytes(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

export function smartsInRange(value: number): boolean {
    return Number.isInteger(value) && value >= -16384 && value < 16384;
}
