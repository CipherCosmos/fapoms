import {
  fromResponse,
  fromNetwork,
  translateError,
  classifyError,
  userMessage,
  fieldErrorKeys,
  AppError,
} from './errors';

describe('ErrorTranslator', () => {
  describe('translateError', () => {
    it('translates a stale-version conflict (via the code field) to conflict with requiresRefresh = true', () => {
      const err = fromResponse(409, {
        code: 'STALE_ASSIGNMENT_VERSION',
        message: 'STALE_ASSIGNMENT_VERSION: Assignment has been updated to version 3 (client expected 2). Please refresh and try again.',
      });
      const translated = translateError(err);

      expect(translated.category).toBe('conflict');
      expect(translated.title).toBe('Assignment Changed');
      expect(translated.retryable).toBe(false);
      expect(translated.requiresRefresh).toBe(true);
      expect(translated.message).toContain('updated by someone else');
      expect(translated.action).toContain('Reload the assignment');
    });

    it('prefers the code field over message-text matching when both are present', () => {
      const err = fromResponse(409, {
        code: 'STALE_EMPANELMENT_VERSION',
        // The message text alone would never match `STALE_ASSIGNMENT_VERSION`, but it does carry
        // its own, different code — proving `code` wins rather than a text scan of `message`.
        message: 'STALE_EMPANELMENT_VERSION: this client standing has been updated to version 3.',
      });
      expect(translateError(err).title).toBe('Empanelment Changed');
    });

    it('falls back to matching the message text when no code field is present', () => {
      const err = fromResponse(409, {
        message: 'DEFINITE_DUPLICATE: An assayer with PAN ABCDE1234F already exists (John Doe).',
      });
      expect(translateError(err).title).toBe('Already Registered');
    });

    it('ignores a code this build does not recognise', () => {
      const err = fromResponse(409, { code: 'SOME_FUTURE_CODE_NOT_YET_SHIPPED', message: 'Conflict' });
      expect(err.domainCode).toBeUndefined();
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

    it('translates business rule codes into business_rule category', () => {
      const err = fromResponse(409, {
        code: 'ASSIGNMENT_CANCELLED',
        message: 'ASSIGNMENT_CANCELLED: this assignment was cancelled and cannot be reassigned.',
      });
      const translated = translateError(err);

      expect(translated.category).toBe('business_rule');
      expect(translated.title).toBe('Assignment Cancelled');
      expect(translated.retryable).toBe(false);
      expect(translated.message).toContain('cancelled and cannot be reassigned');
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
      const err = fromResponse(409, {
        code: 'STALE_ASSIGNMENT_VERSION',
        message: 'STALE_ASSIGNMENT_VERSION: Assignment has been updated to version 3.',
      });
      const msg = userMessage(err);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).toContain('updated by someone else');
    });

    it('classifyError retains isConflict and isRetryable booleans', () => {
      const conflictErr = fromResponse(409, { message: 'Conflict' });
      const classified = classifyError(conflictErr);
      expect(classified.isConflict).toBe(true);
      expect(classified.isRetryable).toBe(false);
    });
  });
});

/**
 * A validation failure knows which boxes it is about. It used to stop knowing the moment it
 * crossed into the app.
 *
 * NestJS sends an array of messages, each starting with the property it concerns.
 * `joinServerMessage` collapses that into one paragraph for the banner — which is right, it is
 * what a person reads — and the keys went with it. The registration wizard, the one screen that
 * offers "Go to field", got them back by replaying the collapsing rule in reverse and matching the
 * output by text. That works, and it is forty lines of comment explaining why it has to.
 */
describe('the field keys a validation failure names', () => {
  const validation = (messages: string[]) => fromResponse(400, { message: messages });

  it('keeps the property off each message, in the server’s own spelling', () => {
    const err = validation([
      'panNumber must match /^[A-Z]{5}[0-9]{4}[A-Z]$/',
      'phone must be a valid Indian mobile number',
    ]);
    expect(fieldErrorKeys(err)).toEqual(['panNumber', 'phone']);
  });

  it('names a field once, however many of its rules failed', () => {
    const err = validation([
      'panNumber should not be empty',
      'panNumber must be a string',
      'panNumber must match /^[A-Z]{5}[0-9]{4}[A-Z]$/',
    ]);
    expect(fieldErrorKeys(err)).toEqual(['panNumber']);
  });

  it('keeps the path for a nested DTO, because that is what names the box', () => {
    expect(fieldErrorKeys(validation(['configuration.defaultRadius must not be less than 1'])))
      .toEqual(['configuration.defaultRadius']);
  });

  /**
   * The distinction that stops this putting nonsense on a form: a property name has no spaces and
   * looks like an identifier. A human-written sentence — which is most of what the API sends —
   * does not, and yields nothing rather than a field called "Something".
   */
  it('takes nothing from a sentence written for a person', () => {
    expect(fieldErrorKeys(validation(['Someone else changed this record while you were editing.'])))
      .toEqual([]);
    expect(fieldErrorKeys(fromResponse(409, { message: 'That PAN is already on the roster.' })))
      .toEqual([]);
  });

  it('is empty, not undefined, for every other kind of failure', () => {
    expect(fieldErrorKeys(fromResponse(500, {}))).toEqual([]);
    expect(fieldErrorKeys(fromNetwork(new Error('offline')))).toEqual([]);
    expect(fieldErrorKeys(new AppError('hand-made'))).toEqual([]);
  });

  it('survives being handed something that is not an error at all', () => {
    // Callers reach this from a `catch`, where anything can arrive.
    expect(fieldErrorKeys(undefined)).toEqual([]);
    expect(fieldErrorKeys('a string someone threw')).toEqual([]);
  });

  /**
   * And while the keys were being kept anyway: the banner used to print the property name as the
   * server typed it — "PanNumber should not be empty", "MaxDailyWorkload must not be less than 1"
   * — which is the schema describing itself to a clerk. Only the leading token is touched.
   */
  it('says the field in words, and leaves the rest of the server’s sentence alone', () => {
    const err = validation(['panNumber should not be empty', 'phone should not be empty']);
    expect(userMessage(err)).toContain('2 things need attention');
    expect(userMessage(err)).toContain('Pan Number should not be empty.');
    expect(userMessage(err)).toContain('Phone should not be empty.');
  });

  it('keeps a regex, a number or anything else the message carries after that word', () => {
    const err = validation(['panNumber must match /^[A-Z]{5}[0-9]{4}[A-Z]$/']);
    expect(userMessage(err)).toBe('Pan Number must match /^[A-Z]{5}[0-9]{4}[A-Z]$/.');
  });

  it('names the box, not the path, for a nested DTO', () => {
    expect(userMessage(validation(['configuration.defaultRadius must not be less than 1'])))
      .toBe('Default Radius must not be less than 1.');
  });

  it('does not touch a sentence written for a person', () => {
    const human = 'That PAN is already on the roster.';
    expect(userMessage(validation([human]))).toBe(human);
  });
});

/**
 * THE GENERIC SENTENCE THAT REPLACED A SPECIFIC ONE.
 *
 * Activation refused with "Sunita Rao cannot be activated yet: PAN card has not been checked against
 * the original. Open their Documents tab…". The translation table caught the code and put
 * "Mandatory KYC identity documents (PAN / Aadhaar) must be verified…" on screen instead — which
 * neither says which of the two documents, nor where to go to fix it.
 */
describe('a gate that already names the person and the gap', () => {
  const serverSentence = 'Sunita Rao cannot be activated yet: PAN card has not been checked against the original. '
    + 'Open their Documents tab, check the scan against what is recorded, and mark it verified.';

  it('keeps the server’s own sentence', () => {
    const err = fromResponse(400, { message: serverSentence, code: 'IDENTITY_NOT_VERIFIED' });
    expect(userMessage(err)).toContain('PAN card has not been checked');
    expect(userMessage(err)).toContain('Documents tab');
    expect(userMessage(err)).not.toMatch(/Mandatory KYC/);
  });

  it('still falls back to the table when the server sent nothing a person can read', () => {
    const err = fromResponse(400, { code: 'IDENTITY_NOT_VERIFIED' });
    expect(userMessage(err)).toMatch(/Mandatory KYC identity documents/);
  });

  /** The preference is per code: a code without it keeps the table's wording, as before. */
  it('leaves every other code translated exactly as it was', () => {
    const err = fromResponse(403, { message: 'Account suspended for review.', code: 'ACCOUNT_ON_HOLD' });
    expect(userMessage(err)).toMatch(/placed on hold or suspended/);
  });
});
