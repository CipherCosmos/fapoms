/**
 * @jest-environment-options {"url": "https://app.example.com"}
 */
import { safeHttpUrl } from './url';

/**
 * `safeHttpUrl` is the only thing standing between a stored user-editable URL (client website,
 * expense receipt, chat attachment) and an `<a href>` that runs it. A `javascript:` value must
 * never survive this gate — that is the entire stored-XSS class it closes.
 *
 * The app origin comes from the docblock above rather than from a stubbed `window`: these tests
 * used to replace the whole `window` global, which worked only because the suite ran with no
 * `window` at all. Under jsdom that assignment is ignored and every relative-URL assertion
 * resolved against `http://localhost` instead. Setting jsdom's document URL exercises the real
 * `Location` the browser will hand `safeHttpUrl` in production.
 */
describe('safeHttpUrl', () => {

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
