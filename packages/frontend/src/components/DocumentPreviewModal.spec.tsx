import React from 'react';
import { render, screen } from '@testing-library/react';
import { DocumentPreviewModal } from './DocumentPreviewModal';

/**
 * THE FALLBACK THAT NEVER RAN.
 *
 * This viewer decided what to draw from `mimeType`, falling back to a regular expression over
 * `current.url || current.fileName`. Every document reaching it carries a `blob:` URL — truthy, and
 * with no extension — so the `||` never reached the filename and the expression never matched.
 * That would not have mattered if `mimeType` were reliable, but the routes that stream documents
 * send `application/octet-stream` or no type at all, with `nosniff` set: so the type was useless,
 * the fallback was dead, and every scan opened as a download button instead of the document.
 *
 * The name is the only thing that still knows what the file is, so the name is what gets asked.
 */
describe('deciding what a document is before drawing it', () => {
  const show = (item: { url: string; fileName?: string; mimeType?: string }) =>
    render(
      <DocumentPreviewModal open onClose={jest.fn()} items={[{ title: 'PAN card', ...item }]} />,
    );

  it('draws an image the server refused to name', () => {
    show({ url: 'blob:http://localhost/abc-123', fileName: 'pan-card.jpg', mimeType: 'application/octet-stream' });

    const image = screen.getByAltText('PAN card');
    expect(image).toBeInTheDocument();
    expect(image.getAttribute('src')).toBe('blob:http://localhost/abc-123');
  });

  it('draws an image when the server named no type at all', () => {
    show({ url: 'blob:http://localhost/abc-124', fileName: 'aadhaar-front.png', mimeType: '' });

    expect(screen.getByAltText('PAN card')).toBeInTheDocument();
  });

  it('renders an unnamed PDF as a document, not as a download', () => {
    show({ url: 'blob:http://localhost/abc-125', fileName: 'joining-form.pdf', mimeType: 'application/octet-stream' });

    expect(screen.queryByAltText('PAN card')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeInTheDocument();
  });

  /** A type the server DID name is believed — this is a fallback, not a replacement. */
  it('believes a real type when it is given one', () => {
    show({ url: 'blob:http://localhost/abc-126', fileName: 'scan', mimeType: 'image/webp' });

    expect(screen.getByAltText('PAN card')).toBeInTheDocument();
  });

  /**
   * TIFF is an accepted upload that no browser draws, and an unknown extension could be anything.
   * Both stay as the download the viewer already offers rather than becoming a broken image.
   */
  it.each([
    ['branch-flatbed.tiff'],
    ['mystery.dat'],
  ])('offers %s for download rather than drawing something broken', (fileName) => {
    show({ url: 'blob:http://localhost/abc-127', fileName, mimeType: 'application/octet-stream' });

    expect(screen.queryByAltText('PAN card')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).not.toBeInTheDocument();
  });
});
