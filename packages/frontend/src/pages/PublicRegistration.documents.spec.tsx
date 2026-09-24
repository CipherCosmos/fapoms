import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { PublicRegistration } from './PublicRegistration';
import * as registrationApi from '../services/public-registration';
import { AppError } from '../services/errors';
import { CURRENT_CONSENT_NOTICE, ApplicationStatus } from '@fapoms/shared';

jest.mock('../services/public-registration');

const api = registrationApi as jest.Mocked<typeof registrationApi>;
const actual = jest.requireActual('../services/public-registration') as typeof registrationApi;

/**
 * THE DOCUMENTS STEP, AS A CANDIDATE ON A PHONE MEETS IT.
 *
 * One big "Take photo" per document and a small "or choose file". Once something is attached the
 * row shows it — a thumbnail, "Added", a way to retake it and a × to take it off — and "Retake"
 * really replaces (it used to add the new file beside the old one). A file the server refuses is
 * reported in the server's own plain words, with "Take again".
 */
describe('the documents step', () => {
  const TOKEN = 'tok-docs';
  const application = {
    id: 'app-1', fullName: 'Ramesh Kulkarni', mobile: '9822014455', email: 'r@example.com',
    dateOfBirth: '1985-03-14', gender: 'Male', address: '14 Shivaji Nagar, Pune', state: 'Maharashtra',
    city: 'Pune', pincode: '411005', experienceYears: 5, currentEmployer: null, expertise: null, availability: null,
    employmentCategory: 'FREELANCER' as never, consentAcceptedAt: '2026-09-20T00:00:00Z', consentVersion: CURRENT_CONSENT_NOTICE.version,
    status: ApplicationStatus.DRAFT, reviewNotes: null,
    extendedProfile: { fields: {}, references: [{ fullName: 'Meera Rao', phone: '9822014455' }] },
  };
  const notice = { ...CURRENT_CONSENT_NOTICE, grievanceContact: 'Asha Menon' };
  const doc = (requirement: string, filePaths: string[]) => ({ id: `d-${requirement}`, applicationId: 'app-1', requirement, filePaths });

  const start = async (documents: unknown[] = [], requested = ['PHOTOGRAPH', 'BANK_PASSBOOK', 'RENT_AGREEMENT']) => {
    api.hydrateRegistration.mockResolvedValue({
      application, documents, documentsRequested: requested, otpVerified: true, consentNotice: notice, infoRequests: [],
    } as never);
    api.updateRegistrationDraft.mockResolvedValue(application as never);
    render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
    await screen.findByText('Lay flat, good light, all 4 corners.');
  };

  const row = (requirement: string) => document.getElementById(`doc-req-${requirement}`) as HTMLElement;
  const pick = (requirement: string, file: File) => {
    const input = row(requirement).querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  };

  beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

  beforeEach(() => {
    jest.clearAllMocks();
    api.isUploadRejected.mockImplementation(actual.isUploadRejected);
    // A phone with a camera: the scanner is the big button.
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: jest.fn() }, configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  });

  it('offers one big "Take photo" per document, and choosing a file as a small link', async () => {
    await start();
    const photo = within(row('PHOTOGRAPH'));
    expect(photo.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    expect(photo.getByText('or choose file')).toBeInTheDocument();
    expect(photo.getByText('Clear face photo, for your ID card.')).toBeInTheDocument();
  });

  it('badges only the conditional rows, and says exactly when they apply', async () => {
    await start();
    expect(within(row('RENT_AGREEMENT')).getByText('Only if your address differs from Aadhaar')).toBeInTheDocument();
    // Required rows carry no badge at all — the old "Required" / "Pending attachment" noise is gone.
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending attachment')).not.toBeInTheDocument();
    expect(screen.queryByText('Needed to submit')).not.toBeInTheDocument();
  });

  it('adds a first file, without replacing anything', async () => {
    api.uploadRegistrationDocument.mockResolvedValue(doc('PHOTOGRAPH', ['k/photo.jpg']) as never);
    await start();
    const file = new File(['x'], 'me.jpg', { type: 'image/jpeg' });
    pick('PHOTOGRAPH', file);

    await waitFor(() => expect(api.uploadRegistrationDocument).toHaveBeenCalledWith(TOKEN, 'PHOTOGRAPH', file, { replace: false }));
    expect(await within(row('PHOTOGRAPH')).findByText('Added')).toBeInTheDocument();
  });

  it('shows what is attached, and "Retake" really replaces it', async () => {
    api.uploadRegistrationDocument.mockResolvedValue(doc('PHOTOGRAPH', ['k/new.jpg']) as never);
    await start([doc('PHOTOGRAPH', ['k/old.jpg'])]);
    const photo = within(row('PHOTOGRAPH'));

    expect(photo.getByText('Added')).toBeInTheDocument();
    expect(photo.getByRole('button', { name: 'Open Photograph' })).toBeInTheDocument();
    expect(photo.getByRole('button', { name: 'Retake' })).toBeInTheDocument();
    expect(screen.queryByText(/Uploaded & attached/)).not.toBeInTheDocument();

    const file = new File(['x'], 'again.jpg', { type: 'image/jpeg' });
    pick('PHOTOGRAPH', file);
    await waitFor(() => expect(api.uploadRegistrationDocument).toHaveBeenCalledWith(TOKEN, 'PHOTOGRAPH', file, { replace: true }));
  });

  it('takes one file off with its ×, by position', async () => {
    api.removeRegistrationDocumentFile.mockResolvedValue(doc('RENT_AGREEMENT', ['k/p1.jpg']) as never);
    await start([doc('RENT_AGREEMENT', ['k/p1.jpg', 'k/p2.jpg'])]);

    fireEvent.click(within(row('RENT_AGREEMENT')).getByRole('button', { name: 'Remove Rent agreement file 2' }));

    await waitFor(() => expect(api.removeRegistrationDocumentFile).toHaveBeenCalledWith(TOKEN, 'RENT_AGREEMENT', 1));
    await waitFor(() => expect(within(row('RENT_AGREEMENT')).queryByRole('button', { name: /file 2/ })).not.toBeInTheDocument());
  });

  it('goes back to "Take photo" when the last file is removed', async () => {
    api.removeRegistrationDocumentFile.mockResolvedValue(doc('PHOTOGRAPH', []) as never);
    await start([doc('PHOTOGRAPH', ['k/p.jpg'])]);

    fireEvent.click(within(row('PHOTOGRAPH')).getByRole('button', { name: 'Remove Photograph' }));

    expect(await within(row('PHOTOGRAPH')).findByRole('button', { name: 'Take photo' })).toBeInTheDocument();
  });

  it('says the server\'s own words when it refuses a file, and offers to take it again', async () => {
    api.uploadRegistrationDocument.mockRejectedValue(new AppError(
      'That file is not a real PDF. Take the photo again.', 'x', 400, 'user-correction-required', 'UPLOAD_REJECTED' as never,
    ));
    await start();
    pick('BANK_PASSBOOK', new File(['x'], 'passbook.pdf', { type: 'application/pdf' }));

    const passbook = within(row('BANK_PASSBOOK'));
    expect(await passbook.findByText('That file is not a real PDF. Take the photo again.')).toBeInTheDocument();
    expect(passbook.getByRole('button', { name: 'Take again' })).toBeInTheDocument();
    expect(passbook.getByText('or choose another file')).toBeInTheDocument();
  });

  it('lists only what is still missing, and nothing once it can go', async () => {
    await start([doc('PHOTOGRAPH', ['k/p.jpg'])]);
    expect(screen.getByText('Still needed:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bank passbook' })).toBeInTheDocument();
    // Nothing already done is listed — the old always-green agreement row included.
    expect(screen.queryByText(/Declaration/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Your photo' })).not.toBeInTheDocument();
  });

  it('shows no list at all when nothing is missing', async () => {
    await start([doc('PHOTOGRAPH', ['k/p.jpg']), doc('BANK_PASSBOOK', ['k/b.pdf'])]);
    expect(screen.queryByText('Still needed:')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });
});
