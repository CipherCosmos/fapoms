import { DocumentStatus, DOCUMENT_TRANSITIONS, canTransitionDocument } from '@fapoms/shared';

/**
 * Where a packet is allowed to go.
 *
 * Documents were the only lifecycle in this system without a transition map: the status column
 * was written straight from the request body. So a packet that had come back from the field,
 * been typed up and delivered could be sent back to UPLOADED — at which point it reappeared in
 * the awaiting-dispatch queue and in the "blocked, paperwork never sent" banner, and staff
 * re-sent work that was already finished.
 */
describe('document lifecycle', () => {
  const ALL = Object.values(DocumentStatus);

  it('never lets a packet go backwards', () => {
    // The pipeline in the order the console draws it. Anything that moves left is a rewind.
    const order = [
      DocumentStatus.UPLOADED,
      DocumentStatus.DISPATCHED,
      DocumentStatus.RECEIVED,
      DocumentStatus.SENT_TO_DATA_ENTRY,
      DocumentStatus.SENT_TO_EXTERNAL_OCR,
      DocumentStatus.EXCEL_GENERATED,
      DocumentStatus.PROCESSED,
      DocumentStatus.COMPLETED,
    ];

    order.forEach((from, i) => {
      order.slice(0, i).forEach((to) => {
        expect({ from, to, allowed: canTransitionDocument(from, to) })
          .toEqual({ from, to, allowed: false });
      });
    });
  });

  it('refuses the specific rewind that re-sent finished paperwork', () => {
    expect(canTransitionDocument(DocumentStatus.COMPLETED, DocumentStatus.UPLOADED)).toBe(false);
    expect(canTransitionDocument(DocumentStatus.RECEIVED, DocumentStatus.UPLOADED)).toBe(false);
  });

  it('admits the three ways a packet legitimately leaves UPLOADED', () => {
    // A pre-field PDF goes out to the assayer...
    expect(canTransitionDocument(DocumentStatus.UPLOADED, DocumentStatus.DISPATCHED)).toBe(true);
    // ...an audited return is uploaded by the assayer and received in the same act...
    expect(canTransitionDocument(DocumentStatus.UPLOADED, DocumentStatus.RECEIVED)).toBe(true);
    // ...and a generated Excel is produced at the end of the job, not moved through it.
    expect(canTransitionDocument(DocumentStatus.UPLOADED, DocumentStatus.COMPLETED)).toBe(true);
  });

  it('allows every step the service actually performs', () => {
    // Each pair below is a transition some method in DocumentService makes today.
    const performed: Array<[DocumentStatus, DocumentStatus]> = [
      [DocumentStatus.UPLOADED, DocumentStatus.DISPATCHED],          // dispatchDocument
      [DocumentStatus.DISPATCHED, DocumentStatus.RECEIVED],          // receiveDocument (pre-field)
      [DocumentStatus.UPLOADED, DocumentStatus.RECEIVED],            // receiveDocument (assayer return)
      [DocumentStatus.RECEIVED, DocumentStatus.SENT_TO_DATA_ENTRY],  // assignForDataEntry
      [DocumentStatus.RECEIVED, DocumentStatus.SENT_TO_EXTERNAL_OCR],       // markSentToExternalOcr
      [DocumentStatus.SENT_TO_DATA_ENTRY, DocumentStatus.SENT_TO_EXTERNAL_OCR],
      [DocumentStatus.UPLOADED, DocumentStatus.COMPLETED],           // upload-excel
    ];
    for (const [from, to] of performed) {
      expect({ from, to, allowed: canTransitionDocument(from, to) })
        .toEqual({ from, to, allowed: true });
    }
  });

  it('lets a packet be archived from anywhere, and go nowhere afterwards', () => {
    for (const from of ALL) {
      if (from === DocumentStatus.ARCHIVED) continue;
      expect(canTransitionDocument(from, DocumentStatus.ARCHIVED)).toBe(true);
    }
    expect(DOCUMENT_TRANSITIONS[DocumentStatus.ARCHIVED]).toEqual([]);
  });

  it('names an onward step for every state except the terminal one', () => {
    for (const s of ALL) {
      const onward = DOCUMENT_TRANSITIONS[s];
      expect(Array.isArray(onward)).toBe(true);
      if (s !== DocumentStatus.ARCHIVED) expect(onward!.length).toBeGreaterThan(0);
    }
  });
});
