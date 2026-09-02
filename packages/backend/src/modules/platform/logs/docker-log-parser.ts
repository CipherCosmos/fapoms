import type { LogLine, LogStream } from '@fapoms/shared';

/**
 * Turns Docker's log bytes into lines.
 *
 * Two things make this more than a `split('\n')`.
 *
 * First, framing. A container started without a TTY — which is every container in both of our
 * stacks — does not get a plain byte stream. Docker multiplexes stdout and stderr over one
 * connection, prefixing each chunk with an eight-byte header: one byte naming the stream, three
 * padding bytes, then a big-endian uint32 length. Treating that as text puts a null byte and a
 * stray glyph at the head of roughly every line, which is precisely the sort of "the log viewer
 * is subtly broken" that survives review because it still looks like log output.
 *
 * Second, chunk boundaries. Reading a live stream hands you arbitrary slices of bytes: a frame
 * header can arrive split across two reads, and a line can arrive in three. The parser therefore
 * holds state between chunks and emits only lines it has actually seen the end of, keeping the
 * remainder for next time.
 */
export class DockerLogParser {
  /** Bytes seen but not yet consumed — a partial frame, or a partial header. */
  private buffered: Uint8Array = new Uint8Array(0);
  /** Text seen but not yet terminated by a newline, per stream. */
  private readonly partial: Record<LogStream, string> = { stdout: '', stderr: '' };
  private readonly decoder = new TextDecoder('utf-8');

  /** @param tty Whether the container was started with a TTY, in which case there is no framing. */
  constructor(private readonly tty: boolean) {}

  /** Feed one chunk; get back every line it completed. */
  push(chunk: Uint8Array): LogLine[] {
    if (this.tty) return this.emit('stdout', this.decoder.decode(chunk, { stream: true }));

    this.buffered = concat(this.buffered, chunk);
    const lines: LogLine[] = [];

    // Consume as many whole frames as the buffer now holds.
    for (;;) {
      if (this.buffered.length < 8) break;
      const header = this.buffered.subarray(0, 8);
      const size = (header[4] << 24 | header[5] << 16 | header[6] << 8 | header[7]) >>> 0;
      if (this.buffered.length < 8 + size) break;

      const payload = this.buffered.subarray(8, 8 + size);
      this.buffered = this.buffered.subarray(8 + size);
      // Stream byte: 1 is stdout, 2 is stderr. Anything else (0 = stdin) cannot occur on a log
      // stream, and is treated as stdout rather than dropped — losing a line is worse than
      // filing it under the wrong stream.
      const stream: LogStream = header[0] === 2 ? 'stderr' : 'stdout';
      lines.push(...this.emit(stream, this.decoder.decode(payload, { stream: true })));
    }
    return lines;
  }

  /**
   * Flush whatever is left when the stream ends. A container's final line often has no trailing
   * newline — the crash message you actually wanted is exactly the line most likely to lack one.
   */
  flush(): LogLine[] {
    const lines: LogLine[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = this.partial[stream];
      if (rest) {
        this.partial[stream] = '';
        const parsed = parseLine(rest, stream);
        if (parsed) lines.push(parsed);
      }
    }
    return lines;
  }

  private emit(stream: LogStream, text: string): LogLine[] {
    const combined = this.partial[stream] + text;
    const parts = combined.split('\n');
    // The last element is whatever followed the final newline: either '' or a partial line.
    this.partial[stream] = parts.pop() ?? '';
    const out: LogLine[] = [];
    for (const part of parts) {
      const parsed = parseLine(part, stream);
      if (parsed) out.push(parsed);
    }
    return out;
  }
}

/**
 * Split Docker's `timestamps=1` prefix off the front of a line.
 *
 * The prefix is RFC3339 with nanosecond precision, then a single space. Nanoseconds do not
 * survive a JS Date, so the string is kept verbatim rather than round-tripped — the viewer shows
 * what the container actually recorded.
 */
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/s;

function parseLine(raw: string, stream: LogStream): LogLine | null {
  // Strip a trailing CR from containers that write CRLF; keep everything else byte-for-byte.
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line === '') return null;
  const m = TS.exec(line);
  if (m) return { ts: m[1], stream, text: m[2] };
  return { ts: null, stream, text: line };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
