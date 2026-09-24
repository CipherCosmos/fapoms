import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApplicationStatus } from '@fapoms/shared';

import { ApplicationDetailDrawer } from './ApplicationDetailDrawer';
import { api } from '../../../services/api';

/**
 * A FORM NOBODY HAS SENT IN IS NOT A FORM WAITING FOR A DECISION.
 *
 * These assertions were written against the Applications PAGE, which the hiring pipeline replaced.
 * The behaviour they pin belongs to this drawer and matters as much as it ever did: a candidate who
 * never submitted must not look approvable, and the desk needs the two things that actually help —
 * resend their link, or fill the form in for them.
 */

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
  useCurrentUserId: () => 'hr-user-123',
  canManageAssayers: () => true,
}));
jest.mock('../../../components/ui', () => {
  const actual = jest.requireActual('../../../components/ui');
  return {
    ...actual,
    useConfirm: () => ({
      confirm: jest.fn().mockResolvedValue(true),
      confirmWithReason: jest.fn().mockResolvedValue({ confirmed: true, reason: 'Duplicate test draft' }),
      confirmDialog: null,
    }),
  };
});

const draft = {
  id: 'app-draft-1',
  fullName: 'Suresh Raina',
  mobile: '9876543211',
  email: 'suresh@example.com',
  status: ApplicationStatus.DRAFT,
  createdAt: '2026-09-05T00:00:00.000Z',
};

const draw = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ApplicationDetailDrawer id="app-draft-1" onClose={jest.fn()} onSuccess={jest.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  (api.request as jest.Mock).mockImplementation((url: string) => {
    if (url === '/hr/applications/app-draft-1') {
      return Promise.resolve({ application: draft, documents: [], gaps: [], invitedMobile: null });
    }
    if (url === '/hr/applications/app-draft-1/reject') return Promise.resolve({ success: true });
    return Promise.resolve([]);
  });
});

describe('an application the candidate never submitted', () => {
  it('says so, and offers the two things that help', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Registration Incomplete (Draft)')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Resend link$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Fill in details$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reject$/i })).toBeInTheDocument();
  });

  it('refuses approval and says why, rather than letting it be pressed', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Registration Incomplete (Draft)')).toBeInTheDocument());
    const approve = screen.getByRole('button', { name: /^Approve$/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Candidate has not submitted their application yet');
  });

  it('can still be turned down, with the reason that was given', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Registration Incomplete (Draft)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith(
      '/hr/applications/app-draft-1/reject',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Duplicate test draft' }) }),
    ));
  });
});

/**
 * ONE PAPER, ONE NAME.
 *
 * This screen ran document requirements through `humanizeStatus`, which title-cases an enum — so
 * ten of the twenty-seven documents were called something different here than on every other
 * screen and in the candidate's own copy: "Nda", "Pan card", "Id proof", "Voter id". A reviewer
 * comparing this drawer against the candidate's page was reading two names for one paper.
 */
describe('what the documents are called', () => {
  const submitted = {
    ...draft,
    status: ApplicationStatus.PENDING_VALIDATION,
  };
  const withDocuments = (documents: Array<{ requirement: string; filePaths: string[] }>) => {
    (api.request as jest.Mock).mockImplementation((url: string) => {
      if (url === '/hr/applications/app-draft-1') {
        return Promise.resolve({
          application: submitted, documents, gaps: [], invitedMobile: null,
        });
      }
      return Promise.resolve([]);
    });
  };

  it('uses the written label, never a title-cased enum', async () => {
    withDocuments([
      { requirement: 'NDA', filePaths: ['a/nda.pdf'] },
      { requirement: 'PAN_CARD', filePaths: ['a/pan.jpg'] },
      { requirement: 'ID_PROOF', filePaths: [] },
    ]);
    draw();

    await waitFor(() => expect(screen.getByText('Non-disclosure agreement')).toBeInTheDocument());
    expect(screen.getByText('PAN card')).toBeInTheDocument();
    expect(screen.getByText('Identity proof')).toBeInTheDocument();

    for (const humanised of ['Nda', 'Pan card', 'Id proof']) {
      expect(screen.queryByText(humanised)).not.toBeInTheDocument();
    }
  });

  /** A requirement with no written label still has to read as words, not as an enum. */
  it('falls back to humanising a requirement nobody has named', async () => {
    withDocuments([{ requirement: 'SOMETHING_NEW', filePaths: [] }]);
    draw();

    // `humanizeStatus` title-cases every word, so this reads "Something New".
    await waitFor(() => expect(screen.getByText('Something New')).toBeInTheDocument());
  });
});

/**
 * ONE FILE BACK, NOT THE WHOLE APPLICATION.
 *
 * HR can send back a single document requirement with a structured reason — the candidate
 * re-uploads just that file on the same link — and can tick exactly which documents and fields
 * they need instead of writing one free-text note the candidate has to decode.
 */
describe('sending back one file instead of the whole application', () => {
  const submittedWithDocs = () => {
    (api.request as jest.Mock).mockImplementation((url: string) => {
      if (url === '/hr/applications/app-draft-1') {
        return Promise.resolve({
          application: { ...draft, status: ApplicationStatus.PENDING_VALIDATION },
          documents: [{
            id: 'd1', requirement: 'PAN_CARD', filePaths: ['a/pan.jpg'],
            reviewStatus: 'NEEDS_RESUBMIT', rejectionReason: 'ILLEGIBLE', rejectionNote: null,
          }],
          gaps: [],
          invitedMobile: null,
          documentsRequested: ['PHOTOGRAPH', 'PAN_CARD'],
          infoRequests: [
            { kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: 'Retake in daylight.' },
          ],
        });
      }
      if (url.endsWith('/review')) return Promise.resolve({ id: 'd1' });
      if (url.endsWith('/request-info')) return Promise.resolve({ id: 'app-draft-1' });
      return Promise.resolve([]);
    });
  };

  it('flags the sent-back file with its reason and lists the outstanding ask', async () => {
    submittedWithDocs();
    draw();
    await waitFor(() => expect(screen.getByText(/sent back — needs resubmit/i)).toBeInTheDocument());
    expect(screen.getByText(/Too blurred or dark to read/i)).toBeInTheDocument();
    expect(screen.getByText('Waiting on candidate')).toBeInTheDocument();
    expect(screen.getByText(/Retake in daylight/i)).toBeInTheDocument();
  });

  it('opens the targeted request dialog from Request info', async () => {
    submittedWithDocs();
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /^Request info$/i }));
    await waitFor(() => expect(screen.getByText(/Request from/i)).toBeInTheDocument());
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('Fields')).toBeInTheDocument();
  });

  it('sends the ticked documents and fields as one structured request', async () => {
    submittedWithDocs();
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /^Request info$/i }));
    await screen.findByText(/Request from/i);

    fireEvent.click(screen.getByRole('checkbox', { name: /PAN card/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /IFSC code/i }));

    fireEvent.click(screen.getByRole('button', { name: /^Send 2 requests$/i }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith(
      '/hr/applications/app-draft-1/request-info',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          documents: [{ requirement: 'PAN_CARD' }],
          fields: [{ key: 'ifscCode' }],
        }),
      }),
    ));
  });

  it('sends back one file with a structured reason', async () => {
    submittedWithDocs();
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /send back/i }));
    await waitFor(() => expect(screen.getByText(/Why is PAN card being sent back/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('combobox', { name: /Why this document is being sent back/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Too blurred or dark to read/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Yes, send it back$/i }));

    await waitFor(() => expect(api.request).toHaveBeenCalledWith(
      '/hr/applications/app-draft-1/documents/PAN_CARD/review',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'NEEDS_RESUBMIT', reason: 'ILLEGIBLE' }),
      }),
    ));
  });
});
/**
 * A fixed 640px on every screen squeezed each document row — a long name beside three buttons in a
 * row that could not wrap — until it scrolled the drawer sideways.
 */
describe('the room the review drawer gives its documents', () => {
  it('asks for a responsive width rather than a fixed 640px', async () => {
    draw();
    const drawer = await screen.findByRole('dialog');
    const style = drawer.getAttribute('style') ?? '';
    expect(style).toContain('860px');
    expect(style).toContain('94vw');
    expect(style).not.toContain('640px');
  });

  it('lets a long document name wrap instead of pushing the row wider', async () => {
    (api.request as jest.Mock).mockImplementation((url: string) => {
      if (url === '/hr/applications/app-draft-1') {
        return Promise.resolve({
          application: { ...draft, status: ApplicationStatus.PENDING_VALIDATION },
          documents: [{ id: 'd1', requirement: 'ETHICAL_CONDUCT_LETTER', filePaths: ['a/b.pdf'] }],
          gaps: [],
          invitedMobile: null,
        });
      }
      return Promise.resolve([]);
    });
    draw();

    const name = await screen.findByTestId('application-document-name');
    // A flex child keeps `min-width: auto` unless told otherwise, which refuses to shrink below its
    // text; zero is what lets the name break onto a second line.
    expect(['0', '0px']).toContain(name.style.minWidth);
    expect((name.parentElement as HTMLElement).style.flexWrap).toBe('wrap');
  });
});

/**
 * The interviewer's notes were stored every time and shown on no screen, so whoever approved the
 * application was deciding without knowing what the interviewer had thought of them.
 */
describe('what the interviewer said, where the decision is made', () => {
  const withInterview = (interview: unknown) => {
    (api.request as jest.Mock).mockImplementation((url: string) => {
      if (url === '/hr/applications/app-draft-1') {
        return Promise.resolve({
          application: { ...draft, status: ApplicationStatus.PENDING_VALIDATION },
          documents: [], gaps: [], invitedMobile: null, interview,
        });
      }
      return Promise.resolve([]);
    });
  };

  it('shows the outcome, who interviewed them, and the notes', async () => {
    withInterview({
      outcome: 'PASS', notes: 'Steady hands; knows the acid test.',
      interviewedAt: '2026-09-02T10:00:00.000Z', interviewedByName: 'Meera Rao',
    });
    draw();

    const block = await screen.findByTestId('application-interview');
    expect(block).toHaveTextContent('Passed');
    expect(block).toHaveTextContent('Meera Rao');
    expect(block).toHaveTextContent('Steady hands; knows the acid test.');
  });

  it('shows nothing for somebody let in without an interview', async () => {
    withInterview(null);
    draw();

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.queryByText('Registration Incomplete (Draft)')).not.toBeInTheDocument());
    expect(screen.queryByTestId('application-interview')).not.toBeInTheDocument();
  });
});

/**
 * WHO VOUCHES FOR THEM.
 *
 * Submit refuses an application with nobody ringable on it, so a queue row normally carries at
 * least one reference — and the reviewer approving the person should see the names, not
 * discover them on the record afterwards.
 */
describe('the references the candidate named', () => {
  it('lists them beside the identity facts', async () => {
    (api.request as jest.Mock).mockImplementation((url: string) => {
      if (url === '/hr/applications/app-draft-1') {
        return Promise.resolve({
          application: {
            ...draft,
            status: ApplicationStatus.PENDING_VALIDATION,
            extendedProfile: {
              references: [
                { fullName: 'Meera Rao', phone: '9822014455', relationship: 'Former manager', email: 'meera@example.com' },
              ],
            },
          },
          documents: [],
          gaps: [],
          invitedMobile: null,
        });
      }
      return Promise.resolve([]);
    });
    draw();

    await waitFor(() => expect(screen.getByText('References')).toBeInTheDocument());
    expect(screen.getByText('Meera Rao')).toBeInTheDocument();
    expect(screen.getByText(/Former manager/)).toBeInTheDocument();
    expect(screen.getByText(/meera@example.com/)).toBeInTheDocument();
  });

  it('says so when nobody is on file yet', async () => {
    (api.request as jest.Mock).mockImplementation((url: string) => {
      if (url === '/hr/applications/app-draft-1') {
        return Promise.resolve({
          application: { ...draft, status: ApplicationStatus.PENDING_VALIDATION },
          documents: [],
          gaps: [],
          invitedMobile: null,
        });
      }
      return Promise.resolve([]);
    });
    draw();

    await waitFor(() => expect(screen.getByText('References')).toBeInTheDocument());
    expect(screen.getByText(/No references yet/)).toBeInTheDocument();
  });
});
