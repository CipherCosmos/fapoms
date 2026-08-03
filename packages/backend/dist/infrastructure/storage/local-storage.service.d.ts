import { Readable } from 'stream';
import { StorageEngine } from './storage-engine.interface';
export declare class LocalStorageService implements StorageEngine {
    private readonly uploadDir;
    constructor();
    saveFile(fileName: string, buffer: Buffer): Promise<string>;
    private resolveExisting;
    statFile(relativePath: string): Promise<{
        size: number;
        mtimeMs: number;
    }>;
    getFileStream(relativePath: string, start?: number, end?: number): Promise<Readable>;
    deleteFile(relativePath: string): Promise<void>;
}
