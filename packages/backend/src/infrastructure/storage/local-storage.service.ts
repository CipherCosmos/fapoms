import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { StorageEngine } from './storage-engine.interface';

@Injectable()
export class LocalStorageService implements StorageEngine {
  private readonly uploadDir: string;

  constructor() {
    const candidates = [
      path.join(__dirname, '../../../../uploads'),
      path.resolve(process.cwd(), 'packages/uploads'),
      path.resolve(process.cwd(), '../uploads'),
      '/app/packages/uploads',
    ];
    this.uploadDir = candidates.find((c) => fs.existsSync(c)) || candidates[0];
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async saveFile(fileName: string, content: Buffer | Readable): Promise<string> {
    const safeFileName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(this.uploadDir, safeFileName);
    if (Buffer.isBuffer(content)) {
      await fs.promises.writeFile(filePath, content);
    } else {
      const writeStream = fs.createWriteStream(filePath);
      await new Promise<void>((resolve, reject) => {
        content.pipe(writeStream);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        content.on('error', reject);
      });
    }
    return `/uploads/${safeFileName}`;
  }

  /** Resolves a stored relative path to a real file on disk, or throws. */
  private resolveExisting(relativePath: string): string {
    const baseName = path.basename(relativePath);
    const candidatePaths = [
      path.join(this.uploadDir, baseName),
      path.join(__dirname, '../../../../uploads', baseName),
      path.resolve(process.cwd(), 'packages/uploads', baseName),
      path.resolve(process.cwd(), '../uploads', baseName),
      `/app/packages/uploads/${baseName}`,
    ];

    for (const cp of candidatePaths) {
      if (fs.existsSync(cp)) return cp;
    }

    throw new BadRequestException(`File ${relativePath} not found on disk.`);
  }

  /**
   * Size and mtime, needed to serve byte-range requests and validate cache revalidation
   * without reading the file. Field clients on weak links resume interrupted downloads via
   * Range, and skip re-downloading unchanged paperwork via ETag.
   */
  async statFile(relativePath: string): Promise<{ size: number; mtimeMs: number }> {
    const stat = await fs.promises.stat(this.resolveExisting(relativePath));
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  }

  /**
   * Streams a file, optionally a byte range. `start`/`end` are inclusive, matching HTTP
   * Range semantics, so a resumed download can request exactly the missing tail.
   */
  async getFileStream(relativePath: string, start?: number, end?: number): Promise<Readable> {
    const absolutePath = this.resolveExisting(relativePath);
    if (start !== undefined && end !== undefined) {
      return fs.createReadStream(absolutePath, { start, end });
    }
    return fs.createReadStream(absolutePath);
  }

  async deleteFile(relativePath: string): Promise<void> {
    const absolutePath = path.join(this.uploadDir, path.basename(relativePath));
    if (fs.existsSync(absolutePath)) {
      await fs.promises.unlink(absolutePath);
    }
  }
}
