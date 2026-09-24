import {
  BACKGROUND_JOB_KIND_INFO,
  BACKGROUND_JOB_KINDS,
  BACKGROUND_JOB_STATUSES,
  backgroundJobHasDownload,
  backgroundJobLabel,
  backgroundJobRoute,
  isBackgroundJobInFlight,
  isBackgroundJobOpen,
  isBackgroundJobSettled,
} from './background-jobs';

describe('background job vocabulary', () => {
  it('every status is exactly one of in flight, awaiting review, or settled', () => {
    for (const status of BACKGROUND_JOB_STATUSES) {
      const buckets = [isBackgroundJobInFlight(status), status === 'AWAITING_REVIEW', isBackgroundJobSettled(status)];
      expect(buckets.filter(Boolean)).toHaveLength(1);
    }
  });

  it('a rehearsal awaiting review is open (dedupe + tray) but not in flight (no spinner)', () => {
    expect(isBackgroundJobOpen('AWAITING_REVIEW')).toBe(true);
    expect(isBackgroundJobInFlight('AWAITING_REVIEW')).toBe(false);
  });

  it('every declared kind has a label and a page', () => {
    for (const kind of BACKGROUND_JOB_KINDS) {
      expect(backgroundJobLabel(kind)).not.toBe('Background job');
      expect(backgroundJobRoute({ kind, scopeType: null, scopeId: null })).toMatch(/^\//);
    }
  });

  it('a kind this build has never heard of still gets a name, and no link', () => {
    expect(backgroundJobLabel('SOMETHING_NEW')).toBe('Background job');
    expect(backgroundJobRoute({ kind: 'SOMETHING_NEW' as never, scopeType: null, scopeId: null })).toBeNull();
  });

  it('a kind reviewed on its page names its review file, and that file is never offered as a download', () => {
    for (const kind of BACKGROUND_JOB_KINDS) {
      const info = BACKGROUND_JOB_KIND_INFO[kind];
      if (info.reviewOnPage) expect(info.reviewFileName).toBeTruthy();
    }
    const review = { kind: 'BRANCH_IMPORT' as const, hasResultFile: true, resultFileName: 'branch-review.json', result: null };
    expect(backgroundJobHasDownload(review)).toBe(false);
    expect(backgroundJobHasDownload({ ...review, resultFileName: 'branch-import-report.xlsx' })).toBe(true);
    expect(backgroundJobHasDownload({ ...review, kind: 'ROSTER_IMPORT' })).toBe(true);
    expect(backgroundJobHasDownload({ ...review, hasResultFile: false })).toBe(false);
    // A feature's own link still counts, until it expires.
    const link = { summary: 'x', download: { path: '/reports/x', fileName: 'x.xlsx', expiresAt: '2026-09-24T11:00:00.000Z' } };
    expect(backgroundJobHasDownload({ ...review, hasResultFile: false, result: link }, Date.parse('2026-09-24T10:00:00.000Z'))).toBe(true);
    expect(backgroundJobHasDownload({ ...review, hasResultFile: false, result: link }, Date.parse('2026-09-24T12:00:00.000Z'))).toBe(false);
  });
});
