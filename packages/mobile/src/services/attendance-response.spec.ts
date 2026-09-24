import { readAttendanceResponse } from './attendance-response';

describe('reading a check-in/check-out answer', () => {
  it('takes the code from `error` on a 200 {success:false} refusal', () => {
    const r = readAttendanceResponse(true, 200, {
      success: false,
      error: 'NOT_SCHEDULED_TODAY',
      message: 'This audit is scheduled for Friday, 26 September.',
    });
    expect(r).toEqual({
      success: false,
      error: 'This audit is scheduled for Friday, 26 September.',
      code: 'NOT_SCHEDULED_TODAY',
      status: 200,
    });
  });

  it('takes the code from `code` on a thrown (4xx) refusal', () => {
    const r = readAttendanceResponse(false, 403, { code: 'NOT_YOUR_ASSIGNMENT', message: 'Not yours.' });
    expect(r.success).toBe(false);
    expect(r.code).toBe('NOT_YOUR_ASSIGNMENT');
    expect(r.error).toBe('Not yours.');
  });

  it('prefers `code` when both are present', () => {
    expect(readAttendanceResponse(false, 400, { code: 'TOO_FAR_FROM_BRANCH', error: 'Bad Request', message: 'x' }).code)
      .toBe('TOO_FAR_FROM_BRANCH');
  });

  it('does not treat an English sentence in `error` as a code', () => {
    const r = readAttendanceResponse(true, 200, { success: false, error: 'Something went wrong' });
    expect(r.code).toBeUndefined();
    expect(r.error).toBe('Something went wrong');
  });

  it('is a success with no error or code when the server says so', () => {
    expect(readAttendanceResponse(true, 200, { success: true, message: 'Checked in' })).toEqual({
      success: true, error: undefined, code: undefined, status: 200,
    });
  });

  it('survives an unreadable body', () => {
    expect(readAttendanceResponse(false, 502, undefined)).toEqual({ success: false, error: undefined, code: undefined, status: 502 });
  });
});
