import { DockerLogParser } from './docker-log-parser';

/** Build one Docker multiplexed frame: [stream, 0,0,0, len32be, ...payload]. */
function frame(stream: 1 | 2, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + payload.length);
  out[0] = stream;
  const n = payload.length;
  out[4] = (n >>> 24) & 0xff; out[5] = (n >>> 16) & 0xff; out[6] = (n >>> 8) & 0xff; out[7] = n & 0xff;
  out.set(payload, 8);
  return out;
}
const bytes = (s: string) => new TextEncoder().encode(s);

describe('DockerLogParser', () => {
  describe('multiplexed (no TTY) — how both of our stacks actually run', () => {
    it('separates stdout from stderr and strips the frame headers', () => {
      const p = new DockerLogParser(false);
      const lines = [
        ...p.push(frame(1, '2026-09-02T10:00:00.000000000Z hello\n')),
        ...p.push(frame(2, '2026-09-02T10:00:01.000000000Z boom\n')),
      ];
      expect(lines).toEqual([
        { ts: '2026-09-02T10:00:00.000000000Z', stream: 'stdout', text: 'hello' },
        { ts: '2026-09-02T10:00:01.000000000Z', stream: 'stderr', text: 'boom' },
      ]);
    });

    it('reassembles a frame split across two reads', () => {
      const p = new DockerLogParser(false);
      const f = frame(1, '2026-09-02T10:00:00.000000000Z split line\n');
      expect(p.push(f.subarray(0, 5))).toEqual([]);      // header not even complete
      expect(p.push(f.subarray(5, 20))).toEqual([]);     // payload incomplete
      expect(p.push(f.subarray(20))).toEqual([
        { ts: '2026-09-02T10:00:00.000000000Z', stream: 'stdout', text: 'split line' },
      ]);
    });

    it('holds a line back until its newline arrives', () => {
      const p = new DockerLogParser(false);
      expect(p.push(frame(1, 'no newline yet'))).toEqual([]);
      expect(p.push(frame(1, ' ...now there is\n'))).toEqual([
        { ts: null, stream: 'stdout', text: 'no newline yet ...now there is' },
      ]);
    });

    it('handles several frames arriving in one read', () => {
      const p = new DockerLogParser(false);
      const combined = new Uint8Array([...frame(1, 'a\n'), ...frame(1, 'b\n'), ...frame(2, 'c\n')]);
      expect(p.push(combined).map((l) => `${l.stream}:${l.text}`)).toEqual(['stdout:a', 'stdout:b', 'stderr:c']);
    });

    it('emits the final unterminated line on flush — the crash message usually has no newline', () => {
      const p = new DockerLogParser(false);
      p.push(frame(2, 'FATAL: out of memory'));
      expect(p.flush()).toEqual([{ ts: null, stream: 'stderr', text: 'FATAL: out of memory' }]);
      expect(p.flush()).toEqual([]);
    });
  });

  describe('TTY (raw, unframed)', () => {
    it('reads the bytes straight through', () => {
      const p = new DockerLogParser(true);
      expect(p.push(bytes('one\ntwo\n')).map((l) => l.text)).toEqual(['one', 'two']);
    });
  });

  it('keeps nanosecond precision verbatim rather than through a Date', () => {
    const p = new DockerLogParser(false);
    const [line] = p.push(frame(1, '2026-09-02T10:00:00.123456789Z precise\n'));
    expect(line.ts).toBe('2026-09-02T10:00:00.123456789Z');
  });

  it('treats a line with no timestamp prefix as untimed rather than dropping it', () => {
    const p = new DockerLogParser(false);
    expect(p.push(frame(1, 'plain line with no timestamp\n'))).toEqual([
      { ts: null, stream: 'stdout', text: 'plain line with no timestamp' },
    ]);
  });

  it('drops CRLF carriage returns but preserves everything else byte-for-byte', () => {
    const p = new DockerLogParser(false);
    const [line] = p.push(frame(1, 'windows style\r\n'));
    expect(line.text).toBe('windows style');
  });

  it('ignores empty lines rather than emitting blanks', () => {
    const p = new DockerLogParser(false);
    expect(p.push(frame(1, '\n\n\n'))).toEqual([]);
  });
});
