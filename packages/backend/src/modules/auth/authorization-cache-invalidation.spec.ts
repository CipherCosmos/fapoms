import { readFileSync } from 'fs';
import { join } from 'path';
import { rbacPrincipalCacheKey } from './auth.service';

/**
 * A REVOKED ROLE MUST STOP WORKING ON THE NEXT REQUEST, NOT WHEN A TTL HAPPENS TO EXPIRE.
 *
 * `validateJwtPayload` caches the resolved principal — roles, permissions, regions, client — in
 * Redis for ten minutes, because it runs on every authenticated request. That cache is the reason
 * authorization is fast and the reason it can be wrong: between a role being taken away and the
 * key expiring, the old answer is still being served, and the person still has the access.
 *
 * Ten minutes of stale authorization after a revocation is not an acceptable window for a system
 * that revokes access when somebody leaves. So every path that changes what a principal holds
 * deletes the key itself, awaited, before its own HTTP response returns — the TTL is the backstop
 * for a missed invalidation, never the mechanism.
 *
 * ## Why this is a source test
 *
 * The property is "the delete is awaited before the response", and a behavioural test with a mock
 * cache passes whether the call is awaited or fired and forgotten — `void this.cache.del(...)`
 * satisfies `expect(cache.del).toHaveBeenCalled()` perfectly well, and is exactly the bug this
 * guards against. Ordering within the method is what matters, so ordering is what is read.
 *
 * The live half was run against a real server on a hardened database: with one manager's token
 * held constant and no cache flush anywhere, `POST /assignments` answered 400 (allowed, bad body),
 * then 403 the instant OPERATIONS was swapped for AUDITOR, then 400 again the instant it was put
 * back. A region change narrowed the same token's branch list from 10 to 8 on the very next
 * request. See docs/verification-2026-09-10-open-findings.md.
 *
 * ## What is deliberately not claimed
 *
 * Editing `users` or `user_roles` directly in the database invalidates nothing, and cannot: no
 * code runs. That is not a defect, it is what "cached" means — and it is why a direct UPDATE is
 * never the production mechanism for changing access. Two rounds of the live verification were
 * lost to exactly that, with a 403 that named the old state and said nothing about a cache.
 */
describe('a change to what a principal holds takes effect on the next request', () => {
  const SRC = join(__dirname, '..', '..');
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

  /** The body of one method, from its `async name(` to the closing brace at its own depth. */
  const methodBody = (source: string, name: string): string => {
    const at = source.indexOf(`async ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const open = source.indexOf('{', source.indexOf(')', at));
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
    }
    throw new Error(`could not find the end of ${name}`);
  };

  describe('UserService', () => {
    const source = read('modules/user/user.service.ts');

    it.each([
      ['assignRoles', 'roles taken away or given'],
      ['updateUser', 'regions, status or client scope changed'],
    ])('%s deletes the cached principal, awaited, before it returns (%s)', (method) => {
      const body = methodBody(source, method);
      const del = body.indexOf(`this.cache.del(rbacPrincipalCacheKey(`);
      expect(del).toBeGreaterThan(-1);

      // Awaited, not `void`-ed. A fire-and-forget delete can lose the race with the caller's very
      // next request, which is the one request that matters after a revocation.
      const line = body.slice(body.lastIndexOf('\n', del) + 1, body.indexOf('\n', del));
      expect(line).toMatch(/await this\.cache\.del\(/);
      expect(line).not.toMatch(/\bvoid\b/);

      // And before the response: the save has happened, so the new state is durable, and the
      // return has not, so no caller can be served the old principal from this point on.
      const save = body.indexOf('.save(');
      const ret = body.lastIndexOf('return ');
      expect(save).toBeGreaterThan(-1);
      expect(save).toBeLessThan(del);
      expect(del).toBeLessThan(ret);
    });

    it('publishes the event as well, so the other replicas hear about it', () => {
      // The cache is shared Redis, so deleting the key on this node clears it everywhere — the
      // event is for the in-process listeners, and for anything that needs to react beyond the
      // cache (revoking refresh tokens, closing sockets).
      for (const method of ['assignRoles', 'updateUser']) {
        expect(methodBody(source, method)).toMatch(/publish\('user:(role-changed|updated)'/);
      }
    });

    it('ends every session when a password changes, rather than only dropping the cache', () => {
      // A lingering refresh token keeps rotating into fresh access tokens for the whole refresh
      // TTL, which defeats the point of changing a password after a compromise.
      const body = read('modules/user/user.service.ts');
      expect(body).toMatch(/user:password-changed/);
      expect(body).toContain('rbacPrincipalCacheKey');
    });
  });

  describe('AuthService', () => {
    const source = read('modules/auth/auth.service.ts');

    it('listens for both change events and drops the key', () => {
      expect(source).toMatch(/this\.events\.subscribe\('user:updated'/);
      expect(source).toMatch(/this\.events\.subscribe\('user:role-changed'/);
      expect(source).toMatch(/this\.events\.subscribe\('user:password-changed'/);
    });

    it('keys the cache per user, so one invalidation cannot miss and one cannot over-reach', () => {
      expect(rbacPrincipalCacheKey('abc')).toBe('rbac:principal:abc');
      expect(rbacPrincipalCacheKey('abc')).not.toBe(rbacPrincipalCacheKey('abd'));
    });

    it('bounds the worst case even if an invalidation is ever missed', () => {
      // The TTL is a backstop, not the mechanism — but a backstop that was disabled or set to a
      // day would turn a single missed invalidation into a day of stale authorization.
      const ttl = /RBAC_CACHE_TTL_SECONDS',\s*(\d+)\)/.exec(source);
      expect(ttl).not.toBeNull();
      expect(Number(ttl![1])).toBeGreaterThan(0);
      expect(Number(ttl![1])).toBeLessThanOrEqual(900);
    });

    it('drops the assayer principal too, on the app-access paths', () => {
      // Assayers authenticate against their own table and hold no role rows; their access is
      // granted and withdrawn on a different path, which needs the same invalidation.
      expect(source.match(/this\.cache\.del\(this\.principalKey\(assayer\.id\)\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
  });

  describe('nothing else caches an authorization decision without invalidating it', () => {
    it('finds no other cache key holding roles, permissions or regions', () => {
      // A second cache of the same decision is a second thing to remember to invalidate, and the
      // one that gets forgotten. If this ever fails, the new cache needs an invalidation path and
      // a line in this file, not an exemption.
      const { readdirSync, statSync } = jest.requireActual('fs') as typeof import('fs');
      const files: string[] = [];
      (function walk(dir: string) {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      })(SRC);

      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
        for (const m of text.matchAll(/cache\.(?:wrap|set)\(\s*[`'"]([^`'"]*)/g)) {
          const key = m[1];
          if (/role|permission|region|principal|scope/i.test(key) && !key.startsWith('rbac:principal:')) {
            offenders.push(`${file.slice(SRC.length + 1)}: ${key}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
