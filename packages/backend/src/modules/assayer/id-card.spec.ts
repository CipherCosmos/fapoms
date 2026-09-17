import * as PDFDocument from 'pdfkit';
import {
  ID_CARD_JOB_TITLE,
  IdCardInput,
  IdCardTerms,
  buildIdCardPdf,
  cardLine,
  idCardDownloadVerdict,
  idCardLocation,
  idCardPdfInput,
  idCardPreview,
  idCardTextLines,
} from './id-card';

/**
 * The expiry RULE moved out of this file. It used to be pinned here as "always December 31 of the
 * current year" — including a test asserting that a card generated on December 31st expires that
 * same day, which the owner spotted as absurd the moment they saw the process drawn. The rule now
 * lives in `identity-artifacts.ts`, is configurable, and carries a year-end grace window; its
 * table of cases, December-31st joiner first, is in `identity-artifacts.spec.ts`. This file now
 * pins only what the builder still owns: rendering a real PDF from the inputs it is handed.
 */

describe('ID card rendering', () => {
  const input = {
    fullName: 'Ramesh Vitthal Kulkarni',
    assayerCode: 'AS0009',
    city: 'Pune',
    state: 'Maharashtra',
    photograph: null,
    generatedOn: new Date(2026, 8, 12),
    validTill: new Date(2026, 11, 31),
  };

  it('produces a real PDF', async () => {
    const pdf = await buildIdCardPdf(input);
    // `%PDF-` rather than just a non-empty buffer: the first build of this shipped a default
    // import of pdfkit that type-checked, built, and threw `is not a constructor` the moment it
    // was called. Asserting the magic bytes is what makes that reachable from the suite.
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('still renders a card when there is no photograph on file', async () => {
    // Most freshly-promoted assayers have none — the card must issue anyway, with a placeholder.
    await expect(buildIdCardPdf({ ...input, photograph: null })).resolves.toBeInstanceOf(Buffer);
  });

  it('does not fail the whole card on an unreadable photograph', async () => {
    // A corrupt or truncated stored image must not cost somebody their ID card.
    const notAnImage = Buffer.from('this is not a picture');
    await expect(buildIdCardPdf({ ...input, photograph: notAnImage })).resolves.toBeInstanceOf(Buffer);
  });

  it('does not leave the photo clip in force after an unreadable photograph', async () => {
    // The clip to the photo box is set inside a save(); a throwing image used to skip the
    // restore(), so every line drawn afterwards — name, ID, dates — was clipped off the card while
    // the PDF still "rendered". Balanced save/restore is what keeps the rest of the card visible.
    const proto = (PDFDocument as any).prototype;
    const save = jest.spyOn(proto, 'save');
    const restore = jest.spyOn(proto, 'restore');
    try {
      await buildIdCardPdf({ ...input, photograph: Buffer.from('this is not a picture') });
      expect(save.mock.calls.length).toBeGreaterThan(0);
      expect(restore.mock.calls.length).toBe(save.mock.calls.length);
    } finally {
      save.mockRestore();
      restore.mockRestore();
    }
  });
});

/**
 * The card says only what is true (owner's decision, 2026-09-16).
 *
 * An audit found the card printing "VERIFIED OFFICER" on everyone, "CERTIFIED GOLD APPRAISER", a
 * decorative EMV chip, one hard-coded division ("Bullion Audit & Risk Assessment") for the whole
 * workforce, "Head Office" for anybody without a city, and "DIGITAL VERIFICATION:
 * sumeru.global/verify" — a page that does not exist. These tests read what `buildIdCardPdf`
 * ACTUALLY passes to pdfkit's `text()`, not a list the renderer promises to use, so a claim re-added
 * straight into the drawing code goes red here too.
 */
describe('ID card content', () => {
  const generatedOn = new Date(2026, 8, 12);
  const validTill = new Date(2026, 11, 31);

  const full: IdCardInput = {
    fullName: 'Ramesh Vitthal Kulkarni',
    assayerCode: 'AS0009',
    city: 'Pune',
    state: 'Maharashtra',
    department: 'Gold Loan Audit',
    photograph: null,
    generatedOn,
    validTill,
    signatoryName: 'Anita Rao',
    signatoryTitle: 'Director - Operations',
    helplinePhone: '+91 80 4000 1234',
    officeAddress: '12 MG Road,\nBengaluru 560001',
  };

  const bare: IdCardInput = {
    fullName: 'Ramesh Vitthal Kulkarni',
    assayerCode: 'AS0009',
    city: null,
    state: null,
    department: null,
    photograph: null,
    generatedOn,
    validTill,
    signatoryName: null,
    signatoryTitle: null,
    helplinePhone: null,
    officeAddress: null,
  };

  const CLAIMS_THE_CARD_MUST_NOT_MAKE = [
    /VERIFIED/i,
    /CERTIFIED/i,
    /sumeru\.global\/verify/i,
    /DIGITAL VERIFICATION/i,
    /Bullion/i,
    /chip/i,
    /Head Office/i,
    /OPERATIONS DESK/i,
    /OFFICIAL APPRAISER CREDENTIAL/i,
    /EMP ID/i,
    /REGION \/ BRANCH/i,
  ];

  interface PrintedBox {
    text: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    wrapWidth: number;
  }

  /** Every string the builder hands to pdfkit, with the box it occupies on the card. */
  async function printed(card: IdCardInput): Promise<{ boxes: PrintedBox[]; pdf: Buffer }> {
    const proto = (PDFDocument as any).prototype;
    const original = proto.text;
    const boxes: PrintedBox[] = [];
    const spy = jest.spyOn(proto, 'text').mockImplementation(function (this: any, ...args: any[]) {
      const [text, x, y, options] = args;
      if (typeof text === 'string' && typeof x === 'number' && typeof y === 'number') {
        const width = this.widthOfString(text);
        const wrapWidth = options?.width ?? this.page.width - x - this.page.margins.right;
        const left = options?.width && options?.align === 'center' ? x + (options.width - width) / 2 : x;
        boxes.push({ text, left, right: left + width, top: y, bottom: y + this.currentLineHeight(), wrapWidth });
      }
      return original.apply(this, args);
    });
    try {
      const pdf = await buildIdCardPdf(card);
      return { boxes, pdf };
    } finally {
      spy.mockRestore();
    }
  }

  const texts = (boxes: PrintedBox[]) => boxes.map((b) => b.text);

  it.each([
    ['fully populated', full],
    ['with nothing optional set', bare],
  ])('makes none of the removed claims (%s)', async (_label, card) => {
    const { boxes, pdf } = await printed(card);
    expect(boxes.length).toBeGreaterThan(0);
    for (const text of texts(boxes)) {
      for (const claim of CLAIMS_THE_CARD_MUST_NOT_MAKE) expect(text).not.toMatch(claim);
    }
    expect(JSON.stringify(idCardTextLines(card))).not.toMatch(/VERIFIED|CERTIFIED|verify|Bullion|chip|Head Office/i);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('names the role with the one shared job title, and labels the code plainly', async () => {
    expect(ID_CARD_JOB_TITLE).toBe('Gold Appraiser');
    const printedTexts = texts((await printed(full)).boxes);
    expect(printedTexts).toContain('GOLD APPRAISER');
    expect(printedTexts).toContain('ID: AS0009');
    expect(printedTexts).toContain('FIELD AUDIT OPERATIONS');
    expect(printedTexts).toContain(`Valid Thru: ${validTill.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`);
  });

  it('prints location, department, signatory and the "if found" lines when they are set', async () => {
    const printedTexts = texts((await printed(full)).boxes);
    expect(printedTexts).toEqual(expect.arrayContaining([
      'LOCATION', 'Pune, Maharashtra',
      'DEPARTMENT', 'Gold Loan Audit',
      'Anita Rao', 'Director - Operations',
      'If found, please call +91 80 4000 1234',
      // Typed over two lines in Settings, printed as one — every slot on the card is one line tall.
      '12 MG Road, Bengaluru 560001',
    ]));
    expect(printedTexts).not.toContain('Authorised signatory');
  });

  it('leaves each line off — label and all — when its value is not set, and never invents one', async () => {
    const printedTexts = texts((await printed(bare)).boxes);
    for (const absent of ['LOCATION', 'DEPARTMENT', 'Head Office', 'Anita Rao', 'Director - Operations']) {
      expect(printedTexts).not.toContain(absent);
    }
    expect(printedTexts.some((t) => /If found/i.test(t))).toBe(false);
    // With no signatory configured the rule is still drawn, captioned, so a wet signature fits.
    expect(printedTexts).toContain('Authorised signatory');
    // The mandatory lines survive an all-null input.
    expect(printedTexts).toEqual(expect.arrayContaining(['Ramesh Vitthal Kulkarni', 'ID: AS0009', 'GOLD APPRAISER']));
  });

  it('prints only a signatory title when only the title is set, without the placeholder caption', async () => {
    const printedTexts = texts((await printed({ ...bare, signatoryTitle: 'Director - Operations' })).boxes);
    expect(printedTexts).toContain('Director - Operations');
    expect(printedTexts).not.toContain('Authorised signatory');
  });

  it('keeps every line on one line and inside the card, with nothing overlapping, whatever the data', async () => {
    const long: IdCardInput = {
      ...full,
      fullName: 'Venkata Satya Surya Narayana Murthy Kondapalli Sri Rama Chandra Prasad Rao Garu',
      assayerCode: 'AS0009-PROVISIONAL-REHIRE-2026',
      city: 'Thiruvananthapuram Rural Industrial Development Area',
      state: 'Andaman and Nicobar Islands',
      department: 'Gold Loan Audit and Collateral Revaluation for Rural and Semi-Urban Branch Networks',
      signatoryName: 'Dr. Anantha Padmanabha Swamy Venkataraghavan Iyengar',
      signatoryTitle: 'Executive Vice President and Head of Field Audit Operations, South and West',
      helplinePhone: '+91 80 4000 1234 / +91 80 4000 5678 / +91 98450 00000 (9 am to 6 pm, Monday to Saturday)',
      officeAddress: 'Sumeru House, 4th Floor, Plot No. 1234/5, Outer Ring Road, Marathahalli, Near the Big Tech Park, Bengaluru, Karnataka 560037, India',
    };

    for (const card of [long, full, bare]) {
      const { boxes, pdf } = await printed(card);
      // One page: pdfkit starts a new page when text runs past the bottom edge.
      expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).toHaveLength(1);

      for (const box of boxes) {
        // Fits its line, so pdfkit had nothing to wrap onto the line below.
        expect(box.right - box.left).toBeLessThanOrEqual(box.wrapWidth + 0.01);
        // Inside the card's 24pt side margins and above its bottom edge.
        expect(box.left).toBeGreaterThanOrEqual(24 - 0.01);
        expect(box.right).toBeLessThanOrEqual(504 - 24 + 0.01);
        expect(box.bottom).toBeLessThanOrEqual(318);
      }

      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const overlap = a.left < b.right - 0.01 && b.left < a.right - 0.01 && a.top < b.bottom - 0.01 && b.top < a.bottom - 0.01;
          if (overlap) throw new Error(`"${a.text}" overlaps "${b.text}"`);
        }
      }
    }
  });
});

describe('ID card preview and download verdict', () => {
  const terms = (over: Partial<IdCardTerms> = {}): IdCardTerms => ({
    refusals: [],
    gated: [],
    gateMode: 'warn',
    issuedOn: new Date('2026-09-16T06:00:00.000Z'),
    validTill: new Date('2026-12-31T00:00:00.000Z'),
    ...over,
  });
  const printedText = { signatoryName: 'Anita Rao', signatoryTitle: null, helplinePhone: '  ', officeAddress: 'Line one,\nLine two' };
  const person = { displayName: 'Ramesh Kulkarni', assayerCode: 'AS0009', department: '  ', city: '', state: 'Maharashtra' };

  it('refuses in every mode on a refusal, and names it', () => {
    for (const gateMode of ['warn', 'enforce']) {
      const v = idCardDownloadVerdict(terms({ refusals: ['the record is invited, not active'], gateMode }));
      expect(v.canDownload).toBe(false);
      expect(v.blockedBecause).toContain('the record is invited, not active');
    }
  });

  it('under enforce, a gated item blocks; under warn it is a gap and the card issues', () => {
    const gated = ['no completed background check on file'];
    expect(idCardDownloadVerdict(terms({ gated, gateMode: 'enforce' }))).toEqual({
      canDownload: false, blockedBecause: gated, gaps: [],
    });
    expect(idCardDownloadVerdict(terms({ gated, gateMode: 'warn' }))).toEqual({
      canDownload: true, blockedBecause: [], gaps: gated,
    });
    expect(idCardDownloadVerdict(terms())).toEqual({ canDownload: true, blockedBecause: [], gaps: [] });
  });

  it('returns the contract shape, with blanks as null and no invented location', () => {
    const preview = idCardPreview(person, terms(), printedText);
    expect(preview).toEqual({
      canDownload: true,
      blockedBecause: [],
      gaps: [],
      issuedOn: '2026-09-16T06:00:00.000Z',
      validTill: '2026-12-31T00:00:00.000Z',
      jobTitle: ID_CARD_JOB_TITLE,
      fullName: 'Ramesh Kulkarni',
      assayerCode: 'AS0009',
      department: null,
      location: 'Maharashtra',
      signatoryName: 'Anita Rao',
      signatoryTitle: null,
      helplinePhone: null,
      officeAddress: 'Line one, Line two',
    });
    expect(idCardLocation(null, undefined)).toBeNull();
    expect(cardLine('   ')).toBeNull();
  });

  it('builds the PDF input from the preview, so the paper prints what the screen shows', () => {
    const preview = idCardPreview({ ...person, department: 'Gold Loan Audit' }, terms(), printedText);
    const face = idCardTextLines(idCardPdfInput(preview, person, terms(), null));
    expect(face.fields).toEqual([
      { label: 'LOCATION', value: preview.location },
      { label: 'DEPARTMENT', value: preview.department },
    ]);
    expect(face.signatory).toEqual({ name: preview.signatoryName, title: null, caption: null });
    expect(face.footer).toEqual([preview.officeAddress]);
    expect(face.role).toBe(preview.jobTitle.toUpperCase());
  });
});
