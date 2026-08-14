import * as fs from 'fs';
import * as path from 'path';

/**
 * Every chunk of a resumable upload must declare its own content type.
 *
 * expo-file-system's Android multipart builder resolves a part's content type as
 * `options.mimeType ?: URLConnection.guessContentTypeFromName(file.name)` and assigns the result
 * to a non-null Kotlin `String`. `guessContentTypeFromName` returns null for any name it does not
 * recognise, and a null landing in a non-null type throws NullPointerException inside the native
 * module — before a single byte leaves the device.
 *
 * That is what shipped: chunks were staged as `chunk_<uploadId>_<index>`, with no extension and no
 * `mimeType`, so every scanned audit packet failed. The server side recorded the shape of it
 * exactly — a session opened, its status polled, and then no chunk request ever arriving — and the
 * client reported only "Upload stalled at part 1", because the exception was caught and dropped by
 * a bare `catch {}`. Three retries hit the same wall in the same silence.
 *
 * The assertions are structural because the fault lives in native code this suite cannot execute:
 * there is no Android runtime here to throw the NPE, and mocking `uploadAsync` would only prove
 * that a mock can be called. What can be checked is that the two things which keep the native
 * module from ever seeing a null are still present at the call site, and that a failure is still
 * given a reason instead of being discarded.
 */
describe('resumable chunk upload contract', () => {
  const source = fs.readFileSync(path.join(__dirname, 'api.service.ts'), 'utf8');

  /** The `uploadAsync` call that sends one chunk, isolated from the single-shot upload below it. */
  const chunkUpload = (() => {
    const start = source.indexOf('const result = await FileSystem.uploadAsync(chunkUrl');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('});', start));
  })();

  it('declares an explicit mimeType for the chunk part', () => {
    // Without this the native module falls back to guessing from the filename, which is the
    // path that returns null and throws.
    expect(chunkUpload).toMatch(/mimeType:\s*'application\/octet-stream'/);
  });

  it('stages the chunk under a name the platform can also type by extension', () => {
    // Belt and braces: even if the explicit mimeType were dropped, a recognised extension keeps
    // `guessContentTypeFromName` from returning null. An extensionless name is what broke it.
    const staged = source.match(/tempUri = `\$\{FileSystem\.cacheDirectory\}chunk_[^`]*`/)?.[0] ?? '';
    expect(staged).toMatch(/\.bin`$/);
  });

  it('keeps the reason a chunk failed instead of discarding it', () => {
    // The original `catch {}` is why a deterministic native crash looked like a flaky network.
    expect(chunkUpload).not.toMatch(/catch\s*\{\s*\}/);
    expect(source).toMatch(/catch \(err: any\) \{[\s\S]{0,400}?lastChunkError = err\?\.message/);
    expect(source).toMatch(/Upload stalled at part \$\{index \+ 1\} of \$\{totalChunks\}/);
    expect(source).toMatch(/lastChunkError \? ` \(\$\{lastChunkError\}\)` : ''/);
  });

  it('sends the chunk under the field name the server reads', () => {
    // The server binds `FileInterceptor('chunk')`; a rename on either side yields
    // "No chunk content received." with a 400 that reads like a client bug.
    expect(chunkUpload).toMatch(/fieldName:\s*'chunk'/);
  });
});
