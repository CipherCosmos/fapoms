import * as fs from 'fs';
import * as path from 'path';
import { EventCategory } from '@fapoms/shared';
import { TypeOrmAuditRepository } from './typeorm-audit.repository';
import { AuditEventEntity } from './audit-event.entity';
import { AuditEvent } from './audit-event';

/**
 * Audit rows written inside a business transaction must ride THAT transaction.
 *
 * Before the scope existed, `recordEvent` always used the injected repository — the default
 * connection — even when called from inside `uow.run`. Two consequences: the caller held one
 * pooled connection and blocked for a second, so twenty concurrent transitions exhausted a
 * twenty-connection pool and stalled for the acquire timeout; and the audit row autocommitted,
 * surviving a rollback of the very change it described.
 */
describe('audit write scope', () => {
  const event = () =>
    AuditEvent.record({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_CREATED',
      entityType: 'ASSIGNMENT',
      entityId: '00000000-0000-4000-8000-000000000001',
    });

  it('writes through the caller\'s transaction manager when a scope is given', async () => {
    const txRepo = { create: jest.fn((r) => r), save: jest.fn(async (r) => ({ id: 'tx-row', ...r })) };
    const manager = { getRepository: jest.fn().mockReturnValue(txRepo) } as any;
    const defaultRepo = { create: jest.fn((r) => r), save: jest.fn(async (r) => ({ id: 'default-row', ...r })) } as any;

    const repo = new TypeOrmAuditRepository(defaultRepo);
    const result = await repo.append(event(), { manager });

    expect(manager.getRepository).toHaveBeenCalledWith(AuditEventEntity);
    expect(txRepo.save).toHaveBeenCalledTimes(1);
    expect(defaultRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'tx-row' });
  });

  it('writes through the default connection when no scope is given', async () => {
    const defaultRepo = { create: jest.fn((r) => r), save: jest.fn(async (r) => ({ id: 'default-row', ...r })) } as any;
    const repo = new TypeOrmAuditRepository(defaultRepo);

    await expect(repo.append(event())).resolves.toEqual({ id: 'default-row' });
    expect(defaultRepo.save).toHaveBeenCalledTimes(1);
  });

  /**
   * Static guard: any `recordEvent(...)` / `recordEventSafe(...)` call whose enclosing block is a
   * `uow.run(` / `inTx(` / `.transaction(` callback must pass `{ manager }`. Heuristic (brace
   * depth), deliberately narrow, and cheap to keep green — the alternative is rediscovering the
   * pool deadlock under load.
   */
  it('every audit write inside a transaction passes the transaction manager', () => {
    const SRC = path.resolve(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '_historical') continue;
          walk(full);
        } else if (full.endsWith('.service.ts') && !full.endsWith('.spec.ts')) {
          files.push(full);
        }
      }
    };
    walk(path.join(SRC, 'modules'));
    walk(path.join(SRC, 'core'));

    const TX_OPEN = /\b(uow\.run|inTx|dataSource\.transaction|manager\.transaction)\(/;
    const offenders: string[] = [];

    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, o) => {
        if (!TX_OPEN.test(line)) return;
        let depth = 0;
        let started = false;
        for (let j = o; j < Math.min(lines.length, o + 500); j++) {
          depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
          if (lines[j].includes('{')) started = true;
          if (started && depth > 0 && /recordEvent(Safe)?\(/.test(lines[j])) {
            // Find this call's closing line and check for the scope argument.
            let paren = 0;
            let opened = false;
            for (let k = j; k < Math.min(lines.length, j + 80); k++) {
              paren += (lines[k].match(/\(/g) ?? []).length - (lines[k].match(/\)/g) ?? []).length;
              if (lines[k].includes('(')) opened = true;
              if (opened && paren <= 0) {
                if (!/\{\s*manager\s*\}/.test(lines[k])) {
                  offenders.push(`${path.relative(SRC, file)}:${j + 1}`);
                }
                break;
              }
            }
          }
          if (started && depth <= 0) break;
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
