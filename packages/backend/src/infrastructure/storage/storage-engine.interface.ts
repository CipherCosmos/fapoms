import { Readable } from 'stream';

export interface StorageEngine {
  saveFile(fileName: string, buffer: Buffer): Promise<string>;
  getFileStream(relativePath: string): Promise<Readable>;
  deleteFile(relativePath: string): Promise<void>;
  getSignedUrl?(key: string, expiresIn?: number): Promise<string>;
}
