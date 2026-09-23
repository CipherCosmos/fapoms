import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InterviewOutcome } from '@fapoms/shared';

import { AddCandidateDialog } from './AddCandidateDialog';
import { InterviewDetailDrawer } from './InterviewDetailDrawer';
import { buildPipeline, type InterviewLike } from './pipeline';
import { api } from '../../../services/api';

/**
 * THE INTERVIEW'S TEST PAPERS, AND INTERVIEWING AGAIN (owner, 2026-09-23).
 *
 * "Passed" and "did not pass" are recorded with the test papers behind them; somebody who did not
 * pass can be seen — papers and all — and interviewed again, the new interview naming the old one.
 */

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../../components/DocumentPreviewModal', () => ({ DocumentPreviewModal: () => null }));
const mockRequest = api.request as jest.Mock;

const failed: InterviewLike = {
  id: 'int-1', candidateName: 'Suresh Patil', mobile: '9811100033', email: 'suresh@example.in',
  outcome: InterviewOutcome.FAIL, interviewedAt: '2026-09-01T10:00:00Z', interviewedByName: 'Asha Menon',
  notes: 'Could not tell 22K from 18K on the touchstone.',
  attachments: [{ storageKey: 'uploads/paper.pdf', fileName: 'touchstone-test.pdf', mimeType: 'application/pdf', size: 900, uploadedAt: '2026-09-01T10:05:00Z', uploadedByName: 'Asha Menon' }],
  previousInterviewId: null,
};

const inQuery = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
);

beforeEach(() => mockRequest.mockReset());

describe('recording an interview with its test papers', () => {
  it('keeps the chosen papers with the interview once it is recorded — a fail included', async () => {
    mockRequest.mockImplementation((url: string) => (url === '/assayer-interviews'
      ? Promise.resolve({ id: 'int-9', candidateName: 'Ramesh Kumar', outcome: InterviewOutcome.FAIL, email: null })
      : Promise.resolve({})));
    inQuery(<AddCandidateDialog open onClose={jest.fn()} onAdded={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('As printed on their Aadhaar or PAN'), { target: { value: 'Ramesh Kumar' } });
    fireEvent.change(screen.getByPlaceholderText('10 digits'), { target: { value: '9876543210' } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'written-test.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText('written-test.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Did not pass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record interview' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayer-interviews/int-9/file', expect.objectContaining({ method: 'POST' })));
    const [, opts] = mockRequest.mock.calls.find(([u]: any[]) => u === '/assayer-interviews/int-9/file')!;
    expect((opts.body as FormData).get('file')).toBeInstanceOf(File);
    expect(await screen.findByText(/recorded as not passed, with 1 test paper/)).toBeInTheDocument();
  });

  it('says so when the interview is recorded but a paper is not', async () => {
    mockRequest.mockImplementation((url: string) => (url === '/assayer-interviews'
      ? Promise.resolve({ id: 'int-9', candidateName: 'Ramesh Kumar', outcome: InterviewOutcome.FAIL, email: null })
      : Promise.reject(new Error('That file type is not accepted'))));
    inQuery(<AddCandidateDialog open onClose={jest.fn()} onAdded={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('As printed on their Aadhaar or PAN'), { target: { value: 'Ramesh Kumar' } });
    fireEvent.change(screen.getByPlaceholderText('10 digits'), { target: { value: '9876543210' } });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['x'], 'paper.pdf')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Did not pass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record interview' }));

    expect(await screen.findByText(/interview is recorded \(not passed\), but "paper.pdf" was not kept/)).toBeInTheDocument();
  });
});

describe('interviewing again', () => {
  it('starts from their details and records the new interview as following the old one', async () => {
    mockRequest.mockResolvedValue({ id: 'int-2', candidateName: 'Suresh Patil', outcome: InterviewOutcome.FAIL, email: null });
    inQuery(<AddCandidateDialog open retakeOf={failed} onClose={jest.fn()} onAdded={jest.fn()} />);

    expect(screen.getByText('Interview Suresh Patil again')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('As printed on their Aadhaar or PAN')).toHaveValue('Suresh Patil');
    expect(screen.getByPlaceholderText('10 digits')).toHaveValue('9811100033');
    // No "add without an interview" — this is an interview.
    expect(screen.queryByRole('tab', { name: 'Add without an interview' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Did not pass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record interview' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayer-interviews', expect.objectContaining({ method: 'POST' })));
    expect(JSON.parse(mockRequest.mock.calls[0][1].body)).toMatchObject({ previousInterviewId: 'int-1', candidateName: 'Suresh Patil' });
  });
});

describe('the interview that did not pass', () => {
  it('shows its test papers, lets more be added, and offers to interview them again', () => {
    const again = jest.fn();
    render(<InterviewDetailDrawer interview={failed} all={[failed]} onClose={jest.fn()} onChanged={jest.fn()} onInterviewAgain={again} />);

    expect(screen.getByRole('button', { name: 'View touchstone-test.pdf' })).toBeInTheDocument();
    expect(screen.getByText(/cannot be removed/)).toBeInTheDocument();
    expect(screen.getByText('Add test paper')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Interview again' }));
    expect(again).toHaveBeenCalledWith(failed);
  });

  it('opens a paper from the interview it belongs to', async () => {
    mockRequest.mockResolvedValue(new Blob(['%PDF']));
    render(<InterviewDetailDrawer interview={failed} all={[failed]} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View touchstone-test.pdf' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayer-interviews/int-1/file/0', { raw: true }));
  });

  it('once interviewed again, points to that interview instead of offering another', () => {
    const retake: InterviewLike = { ...failed, id: 'int-2', outcome: InterviewOutcome.PASS, interviewedAt: '2026-09-20T10:00:00Z', attachments: [], previousInterviewId: 'int-1' };
    const open = jest.fn();
    render(<InterviewDetailDrawer interview={failed} all={[failed, retake]} onClose={jest.fn()} onInterviewAgain={jest.fn()} onOpenInterview={open} />);

    expect(screen.queryByRole('button', { name: 'Interview again' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Passed/ }));
    expect(open).toHaveBeenCalledWith('int-2');
  });

  it('is not offered to somebody who may not record interviews', () => {
    render(<InterviewDetailDrawer interview={failed} all={[failed]} onClose={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Interview again' })).not.toBeInTheDocument();
  });
});

describe('the hiring list', () => {
  it('stops showing "not passed" for somebody interviewed again — the later interview is where they are', () => {
    const retakeFailed: InterviewLike = { ...failed, id: 'int-2', previousInterviewId: 'int-1', interviewedAt: '2026-09-20T10:00:00Z' };
    const rows = buildPipeline({ interviews: [failed, retakeFailed] });
    expect(rows.map((r) => r.id)).toEqual(['int-2']);
    expect(rows[0].note).toMatch(/interviewed again/);
  });
});
