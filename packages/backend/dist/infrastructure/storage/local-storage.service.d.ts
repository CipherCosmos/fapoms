import * as fs from 'fs';
export declare class LocalStorageService {
    private readonly uploadDir;
    constructor();
    saveFile(fileName: string, buffer: Buffer): Promise<string>;
    getFileStream(relativePath: string): Promise<fs.ReadStream>;
    deleteFile(relativePath: string): Promise<void>;
}
