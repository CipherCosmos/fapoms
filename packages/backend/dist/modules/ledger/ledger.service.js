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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LedgerService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const ledger_entry_entity_1 = require("./ledger-entry.entity");
let LedgerService = class LedgerService {
    ledgerRepository;
    constructor(ledgerRepository) {
        this.ledgerRepository = ledgerRepository;
    }
    async addEntry(assayerId, type, amount, referenceId) {
        return this.ledgerRepository.manager.transaction(async (manager) => {
            const assayerRes = await manager.query(`SELECT running_balance FROM assayers WHERE id = $1 FOR UPDATE`, [assayerId]);
            if (!assayerRes || assayerRes.length === 0) {
                throw new Error(`Assayer ${assayerId} not found`);
            }
            const currentBalance = Number(assayerRes[0].running_balance || 0);
            const nextBalance = type === 'CREDIT' ? currentBalance + Number(amount) : currentBalance - Number(amount);
            await manager.query(`UPDATE assayers SET running_balance = $1 WHERE id = $2`, [nextBalance, assayerId]);
            const entry = manager.create(ledger_entry_entity_1.LedgerEntry, {
                assayerId,
                transactionType: type,
                amount,
                runningBalance: nextBalance,
                referenceId,
            });
            return manager.save(entry);
        });
    }
    async getLedger(assayerId) {
        return this.ledgerRepository.find({
            where: { assayerId },
            order: { createdAt: 'DESC' },
        });
    }
};
exports.LedgerService = LedgerService;
exports.LedgerService = LedgerService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(ledger_entry_entity_1.LedgerEntry)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], LedgerService);
//# sourceMappingURL=ledger.service.js.map