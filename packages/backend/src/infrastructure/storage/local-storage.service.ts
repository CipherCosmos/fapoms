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

  async getFileStream(relativePath: string): Promise<Readable> {
    let absolutePath = relativePath.startsWith('/')
      ? path.join(this.uploadDir, path.basename(relativePath))
      : path.join(this.uploadDir, relativePath);

    if (!fs.existsSync(absolutePath)) {
      // Try resolving directly from app root or uploadDir
      const directPath = path.resolve(this.uploadDir, '..', relativePath.replace(/^\//, ''));
      if (fs.existsSync(directPath)) {
        absolutePath = directPath;
      } else {
        throw new BadRequestException(`File ${relativePath} not found on disk.`);
      }
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
