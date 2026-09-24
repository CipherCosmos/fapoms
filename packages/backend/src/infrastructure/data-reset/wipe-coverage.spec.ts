import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { NEVER_WIPEABLE_TABLES, NOT_WIPED_TABLES, WIPE_DOMAINS } from './wipe-domains.registry';

/**
 * Every table the application defines must be accounted for by the data reset.
 *
 * `WIPE_DOMAINS` is a list, and a list only covers the tables that existed when it was written.
 * The hiring pipeline (interviews, applications, their documents), the assayer invoices and the
 * session/MFA tables were all added after it and were never listed — so "clear everything" left the
 * hiring page full and a removed account's MFA secrets in place, with nothing anywhere saying so.
 * This spec reads the tables off the entities themselves, so a new one fails the build until
 * somebody decides whether a wipe clears it.
 */

const SRC = join(__dirname, '..', '..');

function entityTables(dir: string, out: Set<string> = new Set()): Set<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      entityTables(path, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      for (const match of readFileSync(path, 'utf8').matchAll(/@Entity\(\s*'([a-z0-9_]+)'/g)) {
        out.add(match[1]);
      }
    }
  }
  return out;
}

const wiped = WIPE_DOMAINS.flatMap((d) => d.tables);
const protectedTables: readonly string[] = NEVER_WIPEABLE_TABLES;
const keptOnPurpose = Object.keys(NOT_WIPED_TABLES);

describe('data reset covers every table', () => {
  const tables = entityTables(SRC);

  it('finds the entities (the scan itself works)', () => {
    expect(tables.size).toBeGreaterThan(50);
    expect(tables.has('assayers')).toBe(true);
  });

  it('every entity table is wiped by a domain, protected, or kept with a stated reason', () => {
    const classified = new Set([...wiped, ...protectedTables, ...keptOnPurpose]);
    const unaccounted = [...tables].filter((t) => !classified.has(t)).sort();
    expect(unaccounted).toEqual([]);
  });

  it('no table is both wiped and kept', () => {
    const keptSet = new Set([...protectedTables, ...keptOnPurpose]);
    expect(wiped.filter((t) => keptSet.has(t))).toEqual([]);
  });

  it('no table belongs to two domains', () => {
    const seen = new Map<string, string>();
    const doubled: string[] = [];
    for (const domain of WIPE_DOMAINS) {
      for (const table of domain.tables) {
        if (seen.has(table)) doubled.push(`${table} (${seen.get(table)} and ${domain.key})`);
        seen.set(table, domain.key);
      }
    }
    expect(doubled).toEqual([]);
  });

  it('clearing the workforce clears the hiring page', () => {
    const assayers = WIPE_DOMAINS.find((d) => d.key === 'assayers')!.tables;
    expect(assayers).toEqual(
      expect.arrayContaining(['assayer_interviews', 'assayer_applications', 'assayer_application_documents']),
    );
  });
});
