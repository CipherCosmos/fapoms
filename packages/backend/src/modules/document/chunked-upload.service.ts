import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface UploadSession {
  uploadId: string;
  assessmentId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunkSize: number;
  createdBy: string;
  createdAt: number;
}

/**
 * Resumable chunked uploads for field paperwork.
 *
 * Assayers upload scanned audits over rural 2G/weak-3G. A 10MB scan takes ~5-7 minutes on
 * such a link, and a single-request upload that drops at 90% restarts from zero — which on a
 * flaky connection can mean it never completes at all. That is a business problem, not just a
 * slow one.
 *
 * So an upload is a session: the client declares the file, sends fixed-size chunks in any
 * order, asks which chunks landed after a reconnect, and sends only the gaps. Chunks go
 * straight to disk as they arrive, so neither the device nor the server ever holds the whole
 * file in memory.
 *
 * Sessions live on disk (not in memory) specifically so an API restart mid-upload does not
 * discard a partially-transferred file — the client can still resume.
 */
@Injectable()
export class ChunkedUploadService {
  private readonly logger = new Logger(ChunkedUploadService.name);

  /** 512KB: small enough that re-sending a failed chunk is cheap on 2G, large enough to keep per-request overhead low. */
  static readonly DEFAULT_CHUNK_SIZE = 512 * 1024;
  private static readonly MAX_FILE_SIZE = 100 * 1024 * 1024;
  /** Abandoned sessions are reclaimed after this long. */
  private static readonly SESSION_TTL_MS = 24 * 60 * 60 * 1000;

  private readonly stagingDir: string;

  constructor() {
    this.stagingDir = path.join(process.env.UPLOAD_DIR || './uploads', '.chunks');
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  private sessionDir(uploadId: string): string {
    // uploadId is server-generated, but this is a filesystem path — never trust it to be
    // free of traversal sequences.
    const safe = path.basename(uploadId);
    if (!/^[a-f0-9]{32}$/.test(safe)) {
      throw new BadRequestException('Invalid upload id.');
    }
    return path.join(this.stagingDir, safe);
  }

  private metaPath(uploadId: string): string {
    return path.join(this.sessionDir(uploadId), 'session.json');
  }

  createSession(input: {
    assessmentId: string;
    fileName: string;
    fileSize: number;
    createdBy: string;
    chunkSize?: number;
  }): UploadSession {
    if (!input.fileSize || input.fileSize <= 0) {
      throw new BadRequestException('fileSize must be a positive number of bytes.');
    }
    if (input.fileSize > ChunkedUploadService.MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File exceeds the ${ChunkedUploadService.MAX_FILE_SIZE / 1024 / 1024}MB limit.`,
      );
    }

    const chunkSize = input.chunkSize || ChunkedUploadService.DEFAULT_CHUNK_SIZE;
    const uploadId = createHash('md5')
      .update(`${input.assessmentId}:${input.fileName}:${input.fileSize}:${Date.now()}:${Math.random()}`)
      .digest('hex');

    const session: UploadSession = {
      uploadId,
      assessmentId: input.assessmentId,
      fileName: input.fileName,
      fileSize: input.fileSize,
      chunkSize,
      totalChunks: Math.ceil(input.fileSize / chunkSize),
      createdBy: input.createdBy,
      createdAt: Date.now(),
    };

    fs.mkdirSync(this.sessionDir(uploadId), { recursive: true });
    fs.writeFileSync(this.metaPath(uploadId), JSON.stringify(session));
    this.logger.log(
      `Upload session ${uploadId} opened: ${input.fileName} (${input.fileSize} bytes, ${session.totalChunks} chunks)`,
    );
    return session;
  }

  getSession(uploadId: string): UploadSession {
    const meta = this.metaPath(uploadId);
    if (!fs.existsSync(meta)) {
      throw new NotFoundException(`Upload session ${uploadId} not found or already completed.`);
    }
    return JSON.parse(fs.readFileSync(meta, 'utf8'));
  }

  /** Chunk indices already stored — this is what makes resume possible. */
  receivedChunks(uploadId: string): number[] {
    const dir = this.sessionDir(uploadId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.part'))
      .map((f) => parseInt(f.replace('.part', ''), 10))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
  }

  saveChunk(uploadId: string, index: number, data: Buffer): { received: number; total: number } {
    const session = this.getSession(uploadId);
    if (index < 0 || index >= session.totalChunks) {
      throw new BadRequestException(
        `Chunk index ${index} out of range (expected 0..${session.totalChunks - 1}).`,
      );
    }
    if (!data?.length) {
      throw new BadRequestException('Empty chunk.');
    }

    // Write to a temp name then rename: a connection dropped mid-write must not leave a
    // truncated chunk that later looks complete and silently corrupts the assembled file.
    const finalPath = path.join(this.sessionDir(uploadId), `${index}.part`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, finalPath);

    return { received: this.receivedChunks(uploadId).length, total: session.totalChunks };
  }

  /** Assembles the chunks into one file and returns it. Fails loudly if any chunk is missing. */
  assemble(uploadId: string): { buffer: Buffer; session: UploadSession } {
    const session = this.getSession(uploadId);
    const received = this.receivedChunks(uploadId);

    if (received.length !== session.totalChunks) {
      const missing = [];
      for (let i = 0; i < session.totalChunks; i++) if (!received.includes(i)) missing.push(i);
      throw new BadRequestException(
        `Cannot complete upload: ${missing.length} chunk(s) still missing (${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}).`,
      );
    }

    const parts: Buffer[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      parts.push(fs.readFileSync(path.join(this.sessionDir(uploadId), `${i}.part`)));
    }
    const buffer = Buffer.concat(parts);

    if (buffer.length !== session.fileSize) {
      throw new BadRequestException(
        `Assembled file is ${buffer.length} bytes but ${session.fileSize} were declared — the upload is corrupt, please retry.`,
      );
    }
    return { buffer, session };
  }

  discard(uploadId: string): void {
    const dir = this.sessionDir(uploadId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Reclaims staging space from uploads that were started and abandoned. */
  pruneExpiredSessions(): number {
    if (!fs.existsSync(this.stagingDir)) return 0;
    let pruned = 0;
    for (const entry of fs.readdirSync(this.stagingDir)) {
      const meta = path.join(this.stagingDir, entry, 'session.json');
      try {
        if (!fs.existsSync(meta)) continue;
        const session: UploadSession = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (Date.now() - session.createdAt > ChunkedUploadService.SESSION_TTL_MS) {
          fs.rmSync(path.join(this.stagingDir, entry), { recursive: true, force: true });
          pruned++;
        }
      } catch {
        // Unreadable session metadata is itself junk — remove it.
        fs.rmSync(path.join(this.stagingDir, entry), { recursive: true, force: true });
        pruned++;
      }
    }
    if (pruned) this.logger.log(`Pruned ${pruned} expired upload session(s).`);
    return pruned;
  }
}
