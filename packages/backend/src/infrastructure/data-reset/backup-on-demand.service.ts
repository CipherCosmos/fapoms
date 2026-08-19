import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface OnDemandBackup {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Runs `pg_dump` on demand, from inside the backend container, over the network to the `postgres`
 * service — not by shelling out to `deploy/backup.sh`, which assumes host-level `podman exec`
 * access. Giving an application container that kind of reach into the host is its own security
 * hole; a network connection to the database it already talks to all day is not.
 *
 * Same flags `backup.sh` uses (`-Fc --no-owner --no-acl`), so a dump taken here is restorable with
 * the existing `deploy/restore.sh --drill` / `--to-production` unchanged — this is meant to be the
 * same kind of artifact, just triggered from the app instead of a nightly timer.
 */
@Injectable()
export class BackupOnDemandService {
  private readonly logger = new Logger(BackupOnDemandService.name);

  /** A dump under this size is a failed/empty dump, not a real backup — see createDump(). */
  private static readonly MIN_VALID_BYTES = 1024;

  private get backupDir(): string {
    return process.env.DATA_RESET_BACKUP_DIR || '/app/backups';
  }

  /**
   * Takes a dump and returns where it landed. Throws (rather than returning a "failed" result) on
   * any problem — the one caller of this, `DataResetController.execute`, is written to treat a
   * thrown error here as "abort the whole wipe, nothing was touched", which is the only sane
   * response to "the safety net you asked for could not be woven."
   */
  async createDump(): Promise<OnDemandBackup> {
    await fs.mkdir(this.backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `on-demand-${timestamp}.dump`;
    const filePath = path.join(this.backupDir, filename);

    const host = process.env.DB_HOST || 'postgres';
    const port = process.env.DB_PORT || '5432';
    const username = process.env.DB_USERNAME || 'fapoms';
    const database = process.env.DB_DATABASE || 'fapoms';
    const password = process.env.DB_PASSWORD || '';

    try {
      await execFileAsync(
        'pg_dump',
        ['-h', host, '-p', port, '-U', username, '-d', database, '-Fc', '--no-owner', '--no-acl', '-f', filePath],
        { env: { ...process.env, PGPASSWORD: password }, timeout: 5 * 60 * 1000 },
      );
    } catch (error) {
      this.logger.error(`pg_dump failed: ${(error as Error).message}`);
      throw new InternalServerErrorException(
        'Could not take a backup before wiping — nothing was deleted. Uncheck "take a backup first" only if you are certain you do not need one.',
      );
    }

    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || stat.size < BackupOnDemandService.MIN_VALID_BYTES) {
      throw new InternalServerErrorException(
        `pg_dump produced no usable file (${stat?.size ?? 0} bytes) — nothing was deleted.`,
      );
    }

    this.logger.log(`On-demand backup written: ${filename} (${stat.size} bytes)`);
    return { filename, path: filePath, sizeBytes: stat.size, createdAt: new Date().toISOString() };
  }
}
