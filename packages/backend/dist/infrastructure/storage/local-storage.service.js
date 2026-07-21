"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalStorageService = void 0;
const common_1 = require("@nestjs/common");
const fs = require("fs");
const path = require("path");
let LocalStorageService = class LocalStorageService {
    uploadDir = path.join(__dirname, '../../../../uploads');
    constructor() {
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
    }
    async saveFile(fileName, buffer) {
        const safeFileName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const filePath = path.join(this.uploadDir, safeFileName);
        await fs.promises.writeFile(filePath, buffer);
        return `/uploads/${safeFileName}`;
    }
    async getFileStream(relativePath) {
        const absolutePath = path.join(this.uploadDir, path.basename(relativePath));
        if (!fs.existsSync(absolutePath)) {
            throw new common_1.BadRequestException(`File ${relativePath} not found on disk.`);
        }
        return fs.createReadStream(absolutePath);
    }
    async deleteFile(relativePath) {
        const absolutePath = path.join(this.uploadDir, path.basename(relativePath));
        if (fs.existsSync(absolutePath)) {
            await fs.promises.unlink(absolutePath);
        }
    }
};
exports.LocalStorageService = LocalStorageService;
exports.LocalStorageService = LocalStorageService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], LocalStorageService);
//# sourceMappingURL=local-storage.service.js.map