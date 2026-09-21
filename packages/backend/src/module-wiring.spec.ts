import * as fs from 'fs';
import * as path from 'path';

/**
 * A SERVICE THAT ASKS FOR SOMETHING ITS MODULE CANNOT GIVE IT.
 *
 * Injecting the email transport into `UserService` and forgetting to import `NotificationsModule` into
 * `UserModule` passed every unit test — each spec provides its own stub, so nothing in the suite
 * ever asks Nest to resolve the real graph — and then crash-looped the API on boot with
 * "Nest can't resolve dependencies of the UserService … at index [6]".
 *
 * Unit tests cannot catch this by construction, and nothing here boots `AppModule` (that needs a
 * database and a Redis). So this reads the sources instead: for the providers that live in ONE
 * module and are shared across others, a service that injects one must belong to a module that
 * imports its home.
 *
 * Globally-provided things (`CacheService`, `ConfigService`, TypeORM repositories) are not listed:
 * they resolve anywhere, which is what makes them global.
 */

/** Where each cross-module provider lives. A provider that moves house must move here too. */
const PROVIDER_HOMES: Record<string, string> = {
  EmailService: 'NotificationsModule',
  SmsService: 'NotificationsModule',
  NotificationDispatchService: 'NotificationsModule',
  PushNotificationService: 'NotificationsModule',
};

const SRC = path.join(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.service.ts') && !entry.name.includes('.spec.')) out.push(full);
  }
  return out;
}

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The constructor's injected types, as written. */
function injectedTypes(source: string): string[] {
  const clean = withoutComments(source);
  const start = clean.indexOf('constructor(');
  if (start === -1) return [];
  const end = clean.indexOf(') {', start);
  const params = clean.slice(start, end === -1 ? undefined : end);
  return [...params.matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]);
}

/**
 * The contents of one array inside the `@Module({ … })` decorator.
 *
 * Deliberately not a search of the whole file: an ES import at the top proves only that somebody
 * typed the name, and that is what made an earlier version of this guard useless.
 */
function decoratorList(moduleSource: string, key: 'imports' | 'providers' | 'exports'): string {
  const decorator = moduleSource.indexOf('@Module(');
  if (decorator === -1) return '';
  const at = moduleSource.indexOf(`${key}:`, decorator);
  if (at === -1) return '';
  const open = moduleSource.indexOf('[', at);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < moduleSource.length; i++) {
    if (moduleSource[i] === '[') depth++;
    else if (moduleSource[i] === ']') {
      depth--;
      if (depth === 0) return moduleSource.slice(open, i + 1);
    }
  }
  return '';
}

/** The module file that owns a service — the nearest `*.module.ts` beside or above it. */
function owningModule(serviceFile: string): string | null {
  let dir = path.dirname(serviceFile);
  for (let up = 0; up < 3; up++) {
    const found = fs.readdirSync(dir).find((f) => f.endsWith('.module.ts'));
    if (found) return path.join(dir, found);
    dir = path.dirname(dir);
  }
  return null;
}

describe('every service can actually be given what it asks for', () => {
  const services = walk(SRC);

  it('finds services to check at all', () => {
    expect(services.length).toBeGreaterThan(20);
  });

  it.each(Object.keys(PROVIDER_HOMES))(
    'every module whose service injects %s imports the module that provides it',
    (provider) => {
      const home = PROVIDER_HOMES[provider];
      const offenders: string[] = [];

      for (const file of services) {
        const source = fs.readFileSync(file, 'utf8');
        if (!injectedTypes(source).includes(provider)) continue;

        const moduleFile = owningModule(file);
        if (!moduleFile) {
          offenders.push(`${path.basename(file)} (no module found near it)`);
          continue;
        }
        const moduleSource = withoutComments(fs.readFileSync(moduleFile, 'utf8'));
        /*
          The DECORATOR's arrays, not the file's text.

          The first version of this check searched the whole source, which meant a leftover
          `import { NotificationsModule } from …` at the top satisfied it — so the check passed on
          the exact wiring bug that crash-looped the API. An ES import says the file mentions a
          module; only `imports:` says Nest will hand it over.
        */
        const wired = decoratorList(moduleSource, 'imports').includes(home)
          || decoratorList(moduleSource, 'providers').includes(provider);
        if (!wired) {
          offenders.push(`${path.basename(moduleFile)} must import ${home} for ${path.basename(file)}`);
        }
      }

      expect(offenders).toEqual([]);
    },
  );
});
