import {
  AssayerLifecycleStatus,
  DOCUMENT_REJECTION_GUIDANCE,
  DocumentRejectionReason,
  DocumentVerification,
  HR_MAINTAINED_ASSAYER_FIELDS,
  OnboardingDocument,
  SELF_EDITABLE_ASSAYER_FIELDS,
} from '@fapoms/shared';
import { evaluateSelfDocumentChange, evaluateSelfFieldChange, selfFieldGates } from './self-record-capabilities';

/**
 * `GET /assayers/me/capabilities` and the routes that refuse a self-edit read these same
 * functions; the answers below are the ones the routes enforced before they were extracted.
 */
describe('self fields', () => {
  it('self-editable fields are direct, HR-maintained ones locked with HR_MAINTAINED_FIELD', () => {
    const gates = selfFieldGates();
    expect(gates.map((g) => g.field)).toEqual([...SELF_EDITABLE_ASSAYER_FIELDS, ...HR_MAINTAINED_ASSAYER_FIELDS]);
    expect(gates.find((g) => g.field === 'phone')).toEqual({ field: 'phone', mode: 'direct' });
    expect(gates.find((g) => g.field === 'bankAccountNumber')).toMatchObject({ mode: 'locked', code: 'HR_MAINTAINED_FIELD' });
  });

  it('a field on neither list is still refused, as the self-edit route always refused it', () => {
    expect(evaluateSelfFieldChange('displayName').mode).toBe('locked');
  });
});

describe('self documents', () => {
  const approved = { lifecycleStatus: AssayerLifecycleStatus.ACTIVE, photograph: 'photos/a.jpg' };

  it('a verified document is locked until HR asks', () => {
    expect(evaluateSelfDocumentChange(OnboardingDocument.PAN_CARD, { verificationStatus: DocumentVerification.VERIFIED }, null))
      .toEqual({ requirement: 'PAN_CARD', mode: 'locked', code: 'DOCUMENT_VERIFIED_LOCKED', reason: 'HR has verified this. Ask HR if it needs changing.' });
  });

  it('a document HR sent back is reopened, with HR\'s own note when they asked for a re-upload', () => {
    expect(evaluateSelfDocumentChange(OnboardingDocument.PAN_CARD, {
      verificationStatus: DocumentVerification.REJECTED,
      rejectionReason: DocumentRejectionReason.ILLEGIBLE,
      reuploadNote: 'The card is cut off at the bottom, please retake it.',
    }, null)).toEqual({ requirement: 'PAN_CARD', mode: 'reopened', hrNote: 'The card is cut off at the bottom, please retake it.' });
  });

  it('a document rejected in review is reopened with the guidance the notification sent', () => {
    const gate = evaluateSelfDocumentChange(OnboardingDocument.AADHAAR_FRONT, {
      verificationStatus: DocumentVerification.REJECTED, rejectionReason: DocumentRejectionReason.ILLEGIBLE,
    }, null);
    expect(gate).toEqual({ requirement: 'AADHAAR_FRONT', mode: 'reopened', hrNote: DOCUMENT_REJECTION_GUIDANCE[DocumentRejectionReason.ILLEGIBLE] });
  });

  it('an inactive (withdrawn) row neither locks nor reopens', () => {
    expect(evaluateSelfDocumentChange(OnboardingDocument.PAN_CARD, { isActive: false, verificationStatus: DocumentVerification.VERIFIED }, null).mode).toBe('direct');
  });

  it('the photograph locks once the person is approved, only if one exists, and reopens when HR asks', () => {
    expect(evaluateSelfDocumentChange(OnboardingDocument.PHOTOGRAPH, null, approved))
      .toMatchObject({ mode: 'locked', code: 'PHOTOGRAPH_LOCKED' });
    expect(evaluateSelfDocumentChange(OnboardingDocument.PHOTOGRAPH, null, { ...approved, photograph: null }).mode).toBe('direct');
    expect(evaluateSelfDocumentChange(OnboardingDocument.PHOTOGRAPH, null, { ...approved, lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION }).mode).toBe('direct');
    expect(evaluateSelfDocumentChange(OnboardingDocument.PHOTOGRAPH, {
      verificationStatus: DocumentVerification.REJECTED, reuploadNote: 'Plain background please.',
    }, approved)).toMatchObject({ mode: 'reopened', hrNote: 'Plain background please.' });
  });

  it('anything else is direct', () => {
    expect(evaluateSelfDocumentChange(OnboardingDocument.NDA, null, null)).toEqual({ requirement: 'NDA', mode: 'direct' });
    expect(evaluateSelfDocumentChange(OnboardingDocument.PAN_CARD, { verificationStatus: DocumentVerification.PENDING }, null).mode).toBe('direct');
  });
});
