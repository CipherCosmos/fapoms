import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { StorageEngine } from './storage-engine.interface';

@Injectable()
export class LocalStorageService implements StorageEngine {
  private readonly uploadDir = path.join(__dirname, '../../../../uploads');

  constructor() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async saveFile(fileName: string, buffer: Buffer): Promise<string> {
    const safeFileName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(this.uploadDir, safeFileName);
    await fs.promises.writeFile(filePath, buffer);
    return `/uploads/${safeFileName}`;
  }

  /** Resolves a stored relative path to a real file on disk, or throws. */
  private resolveExisting(relativePath: string): string {
    const absolutePath = relativePath.startsWith('/')
      ? path.join(this.uploadDir, path.basename(relativePath))
      : path.join(this.uploadDir, relativePath);

    if (fs.existsSync(absolutePath)) return absolutePath;

    // Try resolving directly from app root or uploadDir
    const directPath = path.resolve(this.uploadDir, '..', relativePath.replace(/^\//, ''));
    if (fs.existsSync(directPath)) return directPath;

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
