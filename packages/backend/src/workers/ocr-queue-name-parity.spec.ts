import * as fs from 'fs';
import * as path from 'path';

/**
 * The OCR worker's @Process handler name MUST equal the name the producer enqueues.
 *
 * Confirmed live 2026-09-04: the worker declared `@Process({ concurrency: 3 })` (no name → Bull's
 * `__default__`) while `OcrProcessingService.enqueue` calls `ocrQueue.add('process', ...)`. Bull
 * dispatches by job name, so every OCR job failed instantly with "Missing process handler for job
 * type process", burned all 5 attempts, and dead-lettered — the entire OCR pipeline was silently
 * dead, with the OcrJobEntity row never leaving its initial status and nothing on screen saying so.
 *
 * This reads both source files and asserts the names still agree. A source-scanning fitness test
 * (comments stripped first) rather than a behavioural one, because the failure is a string mismatch
 * across two files that a unit test on either file alone cannot see — the exact shape of bug that
 * slipped through here. It is deliberately standalone (not folded into worker-concurrency.spec) so
 * it stays green independent of unrelated queue churn.
 */
const SRC = path.join(__dirname, '..');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('OCR queue: worker handler name matches producer enqueue name', () => {
  const worker = stripComments(
    fs.readFileSync(path.join(SRC, 'workers/ocr.worker.ts'), 'utf8'),
  );
  const producer = stripComments(
    fs.readFileSync(path.join(SRC, 'infrastructure/ocr/ocr-processing.service.ts'), 'utf8'),
  );

  it('the producer enqueues a job named "process"', () => {
    // ocrQueue.add('process', ...) — the first string argument is the job name.
    expect(producer).toMatch(/ocrQueue\.add\(\s*['"]process['"]/);
  });

  it('the worker binds a @Process handler to that same name (never the unnamed __default__)', () => {
    // Must be @Process({ name: 'process', ... }) — a bare @Process() or one with only
    // { concurrency } binds __default__ and silently drops every 'process' job.
    expect(worker).toMatch(/@Process\(\s*\{[^}]*name:\s*['"]process['"]/);
    expect(worker).not.toMatch(/@Process\(\s*\{\s*concurrency:[^}]*\}\s*\)/); // the broken form
  });
});
