import { buildPaginationMeta } from './pagination';

describe('buildPaginationMeta', () => {
  it('computes totalPages, hasNext and hasPrevious for a middle page', () => {
    expect(buildPaginationMeta({ page: 2, limit: 10, total: 45 })).toEqual({
      page: 2,
      limit: 10,
      total: 45,
      totalPages: 5,
      hasNext: true,
      hasPrevious: true,
    });
  });

  it('the first page has no previous', () => {
    expect(buildPaginationMeta({ page: 1, limit: 10, total: 45 })).toEqual(
      expect.objectContaining({ hasPrevious: false, hasNext: true }),
    );
  });

  it('the last page has no next, even when total is an exact multiple of limit', () => {
    expect(buildPaginationMeta({ page: 5, limit: 10, total: 50 })).toEqual(
      expect.objectContaining({ totalPages: 5, hasNext: false, hasPrevious: true }),
    );
  });

  it('an empty result set is one (empty) page, not zero', () => {
    expect(buildPaginationMeta({ page: 1, limit: 10, total: 0 })).toEqual(
      expect.objectContaining({ totalPages: 0, hasNext: false, hasPrevious: false }),
    );
  });
});
