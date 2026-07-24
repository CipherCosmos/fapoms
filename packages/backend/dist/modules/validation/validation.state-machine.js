"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationStateMachine = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@fapoms/shared");
const domain_events_1 = require("../../core/events/domain-events");
class ValidationStateMachine {
    static validateTransition(current, target) {
        const validPaths = {
            PENDING: [shared_1.ValidationStatus.ASSIGNED],
            ASSIGNED: [shared_1.ValidationStatus.OCR_PROCESSING],
            OCR_PROCESSING: [shared_1.ValidationStatus.HUMAN_REVIEW],
            HUMAN_REVIEW: [
                shared_1.ValidationStatus.APPROVED,
                shared_1.ValidationStatus.CORRECTION_REQUIRED,
            ],
            CORRECTION_REQUIRED: [shared_1.ValidationStatus.HUMAN_REVIEW],
            APPROVED: [shared_1.ValidationStatus.SUBMITTED],
        };
        const allowed = validPaths[current] || [];
        if (!allowed.includes(target)) {
            throw new common_1.BadRequestException(`Invalid Transition: Cannot transition validation case from ${current} to ${target}.`);
        }
    }
    static approveValidation(validationCase, userId, remarks, notes, ocrResult) {
        this.validateTransition(validationCase.status, shared_1.ValidationStatus.APPROVED);
        const prev = validationCase.status;
        validationCase.status = shared_1.ValidationStatus.APPROVED;
        validationCase.reviewedAt = new Date();
        if (remarks)
            validationCase.remarks = remarks;
        if (notes)
            validationCase.correctionNotes = notes;
        if (ocrResult)
            validationCase.ocrResult = ocrResult;
        return new domain_events_1.ValidationApprovedEvent(validationCase.id, prev, validationCase.status, userId);
    }
    static requestCorrection(validationCase, userId, remarks, notes, ocrResult) {
        this.validateTransition(validationCase.status, shared_1.ValidationStatus.CORRECTION_REQUIRED);
        const prev = validationCase.status;
        validationCase.status = shared_1.ValidationStatus.CORRECTION_REQUIRED;
        if (remarks)
            validationCase.remarks = remarks;
        if (notes)
            validationCase.correctionNotes = notes;
        if (ocrResult)
            validationCase.ocrResult = ocrResult;
        return new domain_events_1.ValidationCorrectionRequestedEvent(validationCase.id, prev, validationCase.status, userId);
    }
    static submitValidation(validationCase, userId, remarks, notes, ocrResult) {
        this.validateTransition(validationCase.status, shared_1.ValidationStatus.SUBMITTED);
        const prev = validationCase.status;
        validationCase.status = shared_1.ValidationStatus.SUBMITTED;
        if (remarks)
            validationCase.remarks = remarks;
        if (notes)
            validationCase.correctionNotes = notes;
        if (ocrResult)
            validationCase.ocrResult = ocrResult;
        return new domain_events_1.ValidationSubmittedEvent(validationCase.id, prev, validationCase.status, userId);
    }
}
exports.ValidationStateMachine = ValidationStateMachine;
//# sourceMappingURL=validation.state-machine.js.map