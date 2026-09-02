import { redactLogLine, REDACTION_RULE_NAMES } from './log-redaction';

describe('redactLogLine', () => {
  it('masks a bearer token but keeps the header readable', () => {
    const out = redactLogLine('GET /x 401 Authorization: Bearer abcdefghijklmnop1234567890');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('GET /x 401');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('masks a bare JWT anywhere in the line', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactLogLine(`token=${jwt} done`)).toBe('token=[redacted] done');
  });

  it('masks the password inside a connection string, keeping host and user', () => {
    const out = redactLogLine('connecting to postgres://fapoms:s3cr3tp4ss@postgres:5432/fapoms');
    expect(out).toBe('connecting to postgres://fapoms:[redacted]@postgres:5432/fapoms');
  });

  it('masks named secrets in env-dump, JSON and query-string punctuation', () => {
    expect(redactLogLine('DB_PASSWORD=hunter2xyz')).toBe('DB_PASSWORD=[redacted]');
    expect(redactLogLine('{"client_secret": "abcd1234efgh"}')).toContain('[redacted]');
    expect(redactLogLine('?api_key=ABCDEF123456&page=2')).toContain('api_key=[redacted]');
  });

  it('masks AWS access key ids', () => {
    expect(redactLogLine('using AKIAIOSFODNN7EXAMPLE now')).toBe('using [redacted] now');
  });

  it('keeps the PEM markers so the reader knows a key was logged', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
    const out = redactLogLine(pem);
    expect(out).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(out).toContain('-----END RSA PRIVATE KEY-----');
    expect(out).not.toContain('MIIEow==');
  });

  it('leaves ordinary log lines completely alone', () => {
    const line = '[Nest] 1  - 09/02/2026, 2:31:07 PM  LOG [AssignmentService] created 42 assignments in 118ms';
    expect(redactLogLine(line)).toBe(line);
  });

  it('does not mangle uuids, request ids or durations that merely look tokenish', () => {
    const line = 'req 550e8400-e29b-41d4-a716-446655440000 finished in 231ms status=200';
    expect(redactLogLine(line)).toBe(line);
  });

  it('has a name for every rule, so a new one cannot arrive untested', () => {
    expect(REDACTION_RULE_NAMES).toEqual([
      'bearer', 'jwt', 'connection-string', 'named-secret', 'aws-access-key-id', 'pem-private-key',
    ]);
  });
});
