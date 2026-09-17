/**
 * REPORT — and only on a second, explicit run, delete — the objects nothing points at.
 *
 * Run with no arguments it lists what it found and changes nothing:
 *
 *   docker exec deploy-backend-1 node packages/backend/dist/infrastructure/retention/orphan-objects.cli.js
 *
 * Run with `--delete` it deletes exactly what it just listed:
 *
 *   docker exec deploy-backend-1 node packages/backend/dist/infrastructure/retention/orphan-objects.cli.js --delete
 *
 * Deliberately a person's decision rather than an hourly job. Deciding an object is unreferenced
 * means knowing every column that can hold a key; the registry is guarded by a spec, but the cost
 * of being wrong is somebody's identity document deleted silently and irreversibly, and that is not
 * a risk worth automating away for a few megabytes.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import type { StorageEngine } from '../storage/storage-engine.interface';
import { findOrphanObjects } from './orphan-objects';

async function main(): Promise<void> {
  const logger = new Logger('OrphanObjects');
  const remove = process.argv.includes('--delete');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const dataSource = app.get(DataSource);
    const storage = app.get<StorageEngine>('StorageEngine');

    const report = await findOrphanObjects(dataSource, storage);
    logger.log(`Objects in the bucket: ${report.scanned}`);
    logger.log(`Keys the database points at: ${report.referenced}`);
    logger.log(`Too recent to judge (an upload may be in flight): ${report.tooRecent}`);
    logger.log(`Pointed at by nothing: ${report.orphans.length}`);

    // Key prefixes only, never whole keys: a key carries the original file name, which carries a
    // person's name — this output ends up pasted into tickets.
    const byPrefix = new Map<string, number>();
    for (const orphan of report.orphans) {
      const prefix = orphan.key.split('/').slice(0, 2).join('/') || '(root)';
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
    }
    for (const [prefix, count] of [...byPrefix].sort((a, b) => b[1] - a[1])) {
      logger.log(`  ${prefix}/… — ${count}`);
    }

    if (!remove) {
      logger.log('Nothing was deleted. Re-run with --delete to remove exactly these objects.');
      return;
    }

    let deleted = 0;
    let failed = 0;
    for (const orphan of report.orphans) {
      try {
        await storage.deleteFile(orphan.key);
        deleted++;
      } catch (error) {
        failed++;
        logger.warn(`Could not delete an object under ${orphan.key.split('/')[0]}/: ${(error as Error).message}`);
      }
    }
    logger.log(`Deleted ${deleted} of ${report.orphans.length}; ${failed} failed.`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`Orphan audit failed: ${(error as Error).message}`);
  process.exit(1);
});
