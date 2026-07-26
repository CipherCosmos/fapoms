"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssayerId = exports.SkillSet = exports.BranchId = void 0;
class BranchId {
    value;
    constructor(value) {
        this.value = value;
        if (!value)
            throw new Error('BranchId cannot be empty');
    }
}
exports.BranchId = BranchId;
class SkillSet {
    values;
    constructor(values) {
        this.values = values;
    }
    has(skill) {
        return this.values.includes(skill);
    }
}
exports.SkillSet = SkillSet;
class AssayerId {
    value;
    constructor(value) {
        this.value = value;
        if (!value)
            throw new Error('AssayerId cannot be empty');
    }
}
exports.AssayerId = AssayerId;
//# sourceMappingURL=planning-domain-contracts.js.map