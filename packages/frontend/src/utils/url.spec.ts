import { safeHttpUrl } from './url';

/**
 * `safeHttpUrl` is the only thing standing between a stored user-editable URL (client website,
 * expense receipt, chat attachment) and an `<a href>` that runs it. A `javascript:` value must
 * never survive this gate — that is the entire stored-XSS class it closes.
 *
 * The test environment runs under jest's "node" testEnvironment (see package.json), which has no
 * `window` global, so `window.location.origin` is stubbed for the duration of these tests.
 */
describe('safeHttpUrl', () => {
  const originalWindow = (global as any).window;

  beforeAll(() => {
    (global as any).window = { location: { origin: 'https://app.example.com' } };
  });

  afterAll(() => {
    (global as any).window = originalWindow;
  });

  it('rejects a javascript: URL', () => {
    expect(safeHttpUrl('javascript:alert(document.cookie)')).toBeNull();
  });

  it('rejects a data: URL', () => {
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects a vbscript: URL', () => {
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
  });

  it('passes through an https URL unchanged', () => {
    expect(safeHttpUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('passes through an http URL', () => {
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it('rejects empty, null and undefined', () => {
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl('   ')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });

  it('resolves a relative path against the app origin (still http/https, so it is allowed)', () => {
    expect(safeHttpUrl('/documents/123')).toBe('https://app.example.com/documents/123');
  });
});
