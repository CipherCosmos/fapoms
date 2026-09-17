import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { scanProfileFor } from '@fapoms/shared';
import { ScanOrAttach } from './ScanOrAttach';
import { DocumentScanner } from './DocumentScanner';

/**
 * The scanner's own maths is tested in `scan-image.spec.ts`, against photographs built pixel by
 * pixel. What is left for here is everything around it that can strand somebody: a camera that is
 * absent, refused or busy, and a camera left running after the sheet is closed.
 *
 * That last one is not a nicety. A `MediaStream` whose tracks are never stopped keeps the phone's
 * torch-adjacent hardware awake and the recording indicator lit — the user closed the scanner and
 * the camera light stayed on.
 */

const stopped = jest.fn();
const track = {
  stop: stopped,
  getCapabilities: () => ({}),
  applyConstraints: jest.fn().mockResolvedValue(undefined),
};
const stream = { getTracks: () => [track], getVideoTracks: () => [track] };

const withCamera = (getUserMedia?: jest.Mock) => {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: getUserMedia ? { getUserMedia } : undefined,
    configurable: true,
  });
};

beforeEach(() => {
  stopped.mockClear();
  // jsdom has no video pipeline; `play()` is not implemented and rejects noisily otherwise.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    value: jest.fn().mockResolvedValue(undefined), configurable: true, writable: true,
  });
});

describe('choosing between a scan and a file', () => {
  it('offers both doors where there is a camera', () => {
    withCamera(jest.fn());
    render(<ScanOrAttach documentLabel="PAN card" onFiles={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    expect(screen.getByText('Choose file')).toBeInTheDocument();
  });

  /** No dead buttons: an old browser or a plain-HTTP page simply has no camera to offer. */
  it('hides the scan button entirely where there is no camera', () => {
    withCamera(undefined);
    render(<ScanOrAttach documentLabel="PAN card" onFiles={jest.fn()} />);

    expect(screen.queryByRole('button', { name: 'Scan' })).not.toBeInTheDocument();
    expect(screen.getByText('Choose file')).toBeInTheDocument();
  });

  it('hands chosen files straight through', () => {
    withCamera(jest.fn());
    const onFiles = jest.fn();
    render(<ScanOrAttach documentLabel="PAN card" onFiles={onFiles} />);

    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'pan.pdf', { type: 'application/pdf' });
    fireEvent.change(picker, { target: { files: [file] } });

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  /**
   * The old `capture="environment"` hint is gone on purpose — it opened the phone's camera app,
   * which is the photograph-of-a-desk this whole component replaces. The picker is now only ever
   * what is already on the device.
   */
  it('no longer sends the picker to the camera app', () => {
    withCamera(jest.fn());
    render(<ScanOrAttach documentLabel="PAN card" onFiles={jest.fn()} />);

    expect(document.querySelector('input[type="file"]')?.getAttribute('capture')).toBeNull();
  });

  it('takes one file for a single-page requirement and several for a multi-page one', () => {
    withCamera(jest.fn());
    const { rerender } = render(<ScanOrAttach documentLabel="PAN card" onFiles={jest.fn()} />);
    expect(document.querySelector('input[type="file"]')?.hasAttribute('multiple')).toBe(false);

    rerender(<ScanOrAttach documentLabel="Bank statement" multiple onFiles={jest.fn()} />);
    expect(document.querySelector('input[type="file"]')?.hasAttribute('multiple')).toBe(true);
  });
});

describe('opening the camera', () => {
  it('asks for the back camera, and only ever as a preference', async () => {
    const getUserMedia = jest.fn().mockResolvedValue(stream);
    withCamera(getUserMedia);

    await act(async () => {
      render(<DocumentScanner documentLabel="PAN card" profile={scanProfileFor('PAN_CARD')} onCancel={jest.fn()} onScanned={jest.fn()} />);
    });

    const constraints = getUserMedia.mock.calls[0][0];
    // `ideal`, never `exact`: a laptop has one camera and it faces the wrong way — demanding the
    // back one there fails outright instead of using what the machine has.
    expect(constraints.video.facingMode).toEqual({ ideal: 'environment' });
    expect(constraints.audio).toBe(false);
  });

  it('stops the camera when the sheet is closed', async () => {
    withCamera(jest.fn().mockResolvedValue(stream));
    const onCancel = jest.fn();

    await act(async () => {
      render(<DocumentScanner documentLabel="PAN card" profile={scanProfileFor('PAN_CARD')} onCancel={onCancel} onScanned={jest.fn()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close the scanner'));
    });

    expect(stopped).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('stops the camera when it is unmounted without being closed', async () => {
    withCamera(jest.fn().mockResolvedValue(stream));

    const view = await act(async () => render(
      <DocumentScanner documentLabel="PAN card" profile={scanProfileFor('PAN_CARD')} onCancel={jest.fn()} onScanned={jest.fn()} />,
    ));
    await act(async () => { view.unmount(); });

    expect(stopped).toHaveBeenCalled();
  });

  /** Three refusals, three different sentences — each naming what the person can do about it. */
  it.each([
    ['NotAllowedError', /blocked for this site/i],
    ['NotFoundError', /No camera on this device/i],
    ['NotReadableError', /another app may be using it/i],
  ])('explains a %s rather than showing a dead viewfinder', async (name, expected) => {
    withCamera(jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { name })));

    await act(async () => {
      render(<DocumentScanner documentLabel="PAN card" profile={scanProfileFor('PAN_CARD')} onCancel={jest.fn()} onScanned={jest.fn()} />);
    });

    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
    // Every one of them points back at the file picker, which always worked.
    expect(screen.getByText(/photo or a PDF instead/i)).toBeInTheDocument();
  });

  it('says which document is being scanned, so the camera is never anonymous', async () => {
    withCamera(jest.fn().mockResolvedValue(stream));

    await act(async () => {
      render(<DocumentScanner documentLabel="Aadhaar card" profile={scanProfileFor('AADHAAR_FRONT')} onCancel={jest.fn()} onScanned={jest.fn()} />);
    });

    expect(screen.getByRole('dialog', { name: 'Scan Aadhaar card' })).toBeInTheDocument();
    expect(screen.getByText('Aadhaar card')).toBeInTheDocument();
  });
});

/**
 * The scanner is told WHICH document it is pointed at, and behaves differently for each. The shape
 * guide and the rotation live on a canvas jsdom does not have, so what is provable here is that the
 * right profile reaches the component and shows up in what it says — the maths behind the shapes is
 * pinned in `document-scan-profile.spec.ts` (shared) and `scan-image.spec.ts`.
 */
describe('knowing which document it is scanning', () => {
  it('tells somebody holding a card what to do with it', async () => {
    withCamera(jest.fn().mockResolvedValue(stream));

    await act(async () => {
      render(
        <ScanOrAttach documentLabel="PAN card" requirement="PAN_CARD" onFiles={jest.fn()} />,
      );
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan' })); });

    expect(screen.getByText(/Lay the card flat inside the outline/i)).toBeInTheDocument();
  });

  /** Two rows, two sides, and each says which one it wants — the commonest thing to get wrong. */
  it('says which side of the Aadhaar each row is asking for', async () => {
    withCamera(jest.fn().mockResolvedValue(stream));

    await act(async () => {
      render(
        <ScanOrAttach documentLabel="Aadhaar (back)" requirement="AADHAAR_BACK" onFiles={jest.fn()} />,
      );
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan' })); });

    expect(screen.getByText(/side with the address/i)).toBeInTheDocument();
  });

  it('falls back to the plain scanner for a requirement it has never heard of', async () => {
    withCamera(jest.fn().mockResolvedValue(stream));

    await act(async () => {
      render(
        <ScanOrAttach documentLabel="Something else" requirement="NOT_A_DOCUMENT" onFiles={jest.fn()} />,
      );
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan' })); });

    expect(screen.getByText(/Fill the frame with the document/i)).toBeInTheDocument();
  });

  /**
   * Which clean-up it opens on is a per-document decision with a reason behind it: an identity
   * card is checked against its hologram and its photograph, so it stays in colour, while a signed
   * form is read, so it starts on the flatbed-like grey that keeps a signature legible. Starting
   * everything in colour — which is what the scanner did before it knew what it was pointed at —
   * hands the desk a photograph of a form to read.
   */
  it.each([
    ['PAN_CARD', 'photo'],
    ['AADHAAR_FRONT', 'photo'],
    ['NDA', 'document'],
    ['JOINING_FORM', 'document'],
  ])('opens %s on the %s finish', async (requirement, expected) => {
    withCamera(jest.fn().mockResolvedValue(stream));

    await act(async () => {
      render(<ScanOrAttach documentLabel="A document" requirement={requirement} onFiles={jest.fn()} />);
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan' })); });

    expect(screen.getByRole('dialog')).toHaveAttribute('data-finish', expected);
  });

  /**
   * The page count is the document's, not the caller's. A PAN card is one page however the file
   * picker beside it is configured — the two used to be the same flag, which meant a single-file
   * picker silently removed the scanner's "Another page" button from multi-page forms.
   */
  it('takes its page count from the document, not from the file picker', async () => {
    withCamera(jest.fn().mockResolvedValue(stream));

    expect(scanProfileFor('PAN_CARD').multiPage).toBe(false);
    expect(scanProfileFor('NDA').multiPage).toBe(true);
  });
});
