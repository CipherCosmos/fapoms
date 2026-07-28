import { Readable } from 'stream';
import { StorageEngine } from './storage-engine.interface';
export declare class LocalStorageService implements StorageEngine {
    private readonly uploadDir;
    constructor();
    saveFile(fileName: string, buffer: Buffer): Promise<string>;
    getFileStream(relativePath: string): Promise<Readable>;
    deleteFile(relativePath: string): Promise<void>;
}
