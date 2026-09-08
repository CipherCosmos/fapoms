import {
  fromResponse,
  fromNetwork,
  translateError,
  classifyError,
  userMessage,
  AppError,
} from './errors';

describe('ErrorTranslator', () => {
  describe('translateError', () => {
    it('translates 409 concurrent modification to conflict with requiresRefresh = true', () => {
      const err = fromResponse(409, { message: 'RECORD_CONCURRENTLY_MODIFIED' });
      const translated = translateError(err);

      expect(translated.category).toBe('conflict');
      expect(translated.title).toBe('Concurrent Modification');
      expect(translated.retryable).toBe(false);
      expect(translated.requiresRefresh).toBe(true);
      expect(translated.message).toContain('modified by another operator');
      expect(translated.action).toContain('Reload authoritative data');
    });

    it('translates 401 session expiration to permission category without refresh', () => {
      const err = fromResponse(401, { message: 'Unauthorized' });
      const translated = translateError(err);

      expect(translated.category).toBe('permission');
      expect(translated.title).toBe('Session Expired');
      expect(translated.retryable).toBe(false);
      expect(translated.requiresRefresh).toBe(false);
      expect(translated.action).toContain('Sign in again');
    });

    it('translates 403 authorization failure to permission category', () => {
      const err = fromResponse(403, { message: 'Forbidden' });
      const translated = translateError(err);

      expect(translated.category).toBe('permission');
      expect(translated.title).toBe('Permission Denied');
      expect(translated.retryable).toBe(false);
      expect(translated.action).toContain('administrator');
    });

    it('translates 404 missing record to not_found category with requiresRefresh = true', () => {
      const err = fromResponse(404, { message: 'Record not found' });
      const translated = translateError(err);

      expect(translated.category).toBe('not_found');
      expect(translated.title).toBe('Record Not Found');
      expect(translated.retryable).toBe(false);
      expect(translated.requiresRefresh).toBe(true);
    });

    it('translates 429 rate limit to rate_limit category with retryable = true', () => {
      const err = fromResponse(429, { message: 'Too many requests' });
      const translated = translateError(err);

      expect(translated.category).toBe('rate_limit');
      expect(translated.title).toBe('Rate Limit Reached');
      expect(translated.retryable).toBe(true);
      expect(translated.requiresRefresh).toBe(false);
    });

    it('translates business rule compliance codes into business_rule category', () => {
      const err = fromResponse(400, { message: 'EMPANELMENT_REVOKED' });
      const translated = translateError(err);

      expect(translated.category).toBe('business_rule');
      expect(translated.title).toBe('Empanelment Revoked');
      expect(translated.retryable).toBe(false);
      expect(translated.message).toContain('revoked or terminated');
    });

    it('translates validation error into validation category', () => {
      const err = fromResponse(400, { message: ['email must be an email'] });
      const translated = translateError(err);

      expect(translated.category).toBe('validation');
      expect(translated.retryable).toBe(false);
    });

    it('translates 500 server exception into server_failure category with retryable = true', () => {
      const err = fromResponse(500, { message: 'Internal server error' });
      const translated = translateError(err);

      expect(translated.category).toBe('server_failure');
      expect(translated.title).toBe('Server Error');
      expect(translated.retryable).toBe(true);
    });

    it('translates network disconnection into network_failure category with retryable = true', () => {
      const err = fromNetwork(new Error('Failed to fetch'));
      const translated = translateError(err);

      expect(translated.category).toBe('network_failure');
      expect(translated.title).toBe('Connection Issue');
      expect(translated.retryable).toBe(true);
    });
  });

  describe('backwards compatibility: userMessage & classifyError', () => {
    it('userMessage returns concise human sentence', () => {
      const err = fromResponse(409, { message: 'RECORD_CONCURRENTLY_MODIFIED' });
      const msg = userMessage(err);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).toContain('modified by another operator');
    });

    it('classifyError retains isConflict and isRetryable booleans', () => {
      const conflictErr = fromResponse(409, { message: 'Conflict' });
      const classified = classifyError(conflictErr);
      expect(classified.isConflict).toBe(true);
      expect(classified.isRetryable).toBe(false);
    });
  });
});
