"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssayerStateMachine = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@fapoms/shared");
const domain_events_1 = require("../../core/events/domain-events");
const LIFECYCLE_TRANSITIONS = {
    [shared_1.AssayerLifecycleStatus.INVITED]: [shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION],
    [shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: [shared_1.AssayerLifecycleStatus.TRAINING, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.TRAINING]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.ACTIVE]: [shared_1.AssayerLifecycleStatus.ON_LEAVE, shared_1.AssayerLifecycleStatus.SUSPENDED, shared_1.AssayerLifecycleStatus.INACTIVE, shared_1.AssayerLifecycleStatus.RESIGNED],
    [shared_1.AssayerLifecycleStatus.ON_LEAVE]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.SUSPENDED]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.TERMINATED],
    [shared_1.AssayerLifecycleStatus.INACTIVE]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.ARCHIVED],
    [shared_1.AssayerLifecycleStatus.RESIGNED]: [shared_1.AssayerLifecycleStatus.ARCHIVED],
    [shared_1.AssayerLifecycleStatus.TERMINATED]: [shared_1.AssayerLifecycleStatus.ARCHIVED],
};
function mapLifecycleToOperationalStatus(lifecycle) {
    if (lifecycle === shared_1.AssayerLifecycleStatus.ACTIVE || lifecycle === shared_1.AssayerLifecycleStatus.ON_LEAVE)
        return 'ACTIVE';
    if (lifecycle === shared_1.AssayerLifecycleStatus.SUSPENDED)
        return 'SUSPENDED';
    return 'INACTIVE';
}
class AssayerStateMachine {
    static validateTransition(assayer, targetStatus) {
        const currentStatus = assayer.lifecycleStatus;
        const allowed = LIFECYCLE_TRANSITIONS[currentStatus];
        if (!allowed || !allowed.includes(targetStatus)) {
            throw new common_1.BadRequestException(`Invalid lifecycle transition from '${currentStatus}' to '${targetStatus}'`);
        }
    }
    static applyTransition(assayer, targetStatus, userId) {
        assayer.lifecycleStatus = targetStatus;
        assayer.status = mapLifecycleToOperationalStatus(targetStatus);
        assayer.updatedBy = userId;
        if (targetStatus === shared_1.AssayerLifecycleStatus.ARCHIVED)
            assayer.isActive = false;
    }
    static verifyDocuments(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION, userId);
        return new domain_events_1.AssayerDocumentVerificationStartedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static initiateBackgroundCheck(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION, userId);
        return new domain_events_1.AssayerBackgroundCheckInitiatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static startTraining(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.TRAINING);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.TRAINING, userId);
        return new domain_events_1.AssayerTrainingStartedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static activate(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.ACTIVE);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.ACTIVE, userId);
        return new domain_events_1.AssayerActivatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static putOnLeave(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.ON_LEAVE);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.ON_LEAVE, userId);
        return new domain_events_1.AssayerOnLeaveEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static suspend(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.SUSPENDED);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.SUSPENDED, userId);
        return new domain_events_1.AssayerSuspendedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static deactivate(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.INACTIVE);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.INACTIVE, userId);
        return new domain_events_1.AssayerDeactivatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static acceptResignation(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.RESIGNED);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.RESIGNED, userId);
        return new domain_events_1.AssayerResignedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static terminate(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.TERMINATED);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.TERMINATED, userId);
        return new domain_events_1.AssayerTerminatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
    static archive(assayer, userId) {
        this.validateTransition(assayer, shared_1.AssayerLifecycleStatus.ARCHIVED);
        const prev = assayer.lifecycleStatus;
        this.applyTransition(assayer, shared_1.AssayerLifecycleStatus.ARCHIVED, userId);
        return new domain_events_1.AssayerArchivedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
    }
}
exports.AssayerStateMachine = AssayerStateMachine;
//# sourceMappingURL=assayer.state-machine.js.map