// Splits a concatenated-MJPEG byte stream into individual JPEG frames by scanning
// for SOI (0xFFD8) / EOI (0xFFD9) markers. Robust against arbitrary chunk sizes.
export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (jpeg: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    let start = this.buf.indexOf(SOI);
    if (start < 0) {
      this.buf = Buffer.alloc(0);
      return;
    }
    while (true) {
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        return;
      }
      const frame = this.buf.subarray(start, end + 2);
      this.onFrame(Buffer.from(frame));
      const next = this.buf.indexOf(SOI, end + 2);
      if (next < 0) {
        this.buf = Buffer.alloc(0);
        return;
      }
      start = next;
      this.buf = this.buf.subarray(start);
      start = 0;
    }
  }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
