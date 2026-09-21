import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { AssignmentService } from './assignment.service';

/**
 * Every dispatched job carries a price, and the price is the desk's.
 *
 * The money model: the fee is ours. The assayer cannot see it on an assignment — the money
 * redaction interceptor strips every fee key from any response an assayer-only principal
 * receives — and first sees it on the monthly bill, which they confirm before anything is
 * approved or paid. That model only works if the figure EXISTS on our side from the moment the
 * job is dispatched.
 *
 * It did not. "Send to app" sent `noFee: true`, which forced the proposed fee to null, and a
 * null fee is not a cheap job — it is an unbillable one. Walking the product end to end:
 * `ASN-2026-000019` was dispatched that way, completed, and produced **zero payouts and zero
 * client lines**. The audit was done, the assayer was not paid, the client was never billed, and
 * the calculator's own ₹1,550 answer was sitting unread in `quotedBaseFee`. The only trace was
 * an attention item reading "Completed with no fee on the assignment — nothing to book", with
 * nothing to click.
 *
 * So there is no "no fee" any more, and this is the file that says so.
 */
describe('resolveProposedFee — a dispatched job always has a price', () => {
  const QUOTE = 1550;

  it.each([
    ['undefined — the field was never sent, which is what "Send to app" does now', undefined],
    ['null — the field was sent empty', null],
  ])('falls back to the quote when the caller supplies %s', (_label, supplied) => {
    expect(AssignmentService.resolveProposedFee(supplied as undefined | null, QUOTE)).toBe(QUOTE);
  });

  it('never returns null, which is the whole point — null is work that can never be paid or billed', () => {
    for (const supplied of [undefined, null, 0, 900, QUOTE, QUOTE * 2]) {
      const fee = AssignmentService.resolveProposedFee(supplied as never, QUOTE);
      expect(fee).not.toBeNull();
      expect(Number.isFinite(fee)).toBe(true);
    }
  });

  it('honours an operator override, because ops genuinely agree a different number by phone', () => {
    expect(AssignmentService.resolveProposedFee(1900, 1700)).toBe(1900);
  });

  it('allows a deliberate zero without turning it into the quote', () => {
    // Zero is a number somebody chose. Absent is not, and the two must not collapse together —
    // that collapse is exactly what `?? quote` would do.
    expect(AssignmentService.resolveProposedFee(0, QUOTE)).toBe(0);
  });

  it('refuses a mistyped extra digit rather than letting it become the price', () => {
    expect(() => AssignmentService.resolveProposedFee(19000, 1700))
      .toThrow(/exceeds twice the contracted quote/i);
  });

  it('accepts exactly twice the quote, the boundary the message names', () => {
    expect(AssignmentService.resolveProposedFee(3400, 1700)).toBe(3400);
  });

  it.each([[-1, 'negative'], [Number.NaN, 'not a number']])(
    'refuses a %s fee (%s)', (supplied) => {
      expect(() => AssignmentService.resolveProposedFee(supplied, QUOTE))
        .toThrow(BadRequestException);
    },
  );
});

/**
 * ONE way a fee is recorded, whichever button produced the assignment.
 *
 * The owner's rule (2026-09-20): "a unique and unified mechanism to record the fees or amount of
 * any assignment — either by Call & Assign or send to a phone. In both cases we record the money
 * manually." The money is never shown in the field app; the monthly invoice is the only reveal,
 * and the assayer confirms it there.
 *
 * What made that untrue was not the amount — both paths already stored one — but WHERE it was
 * stored. `agreedFee` was written only when the desk ticked "agreed on this call"
 * (`acceptOnBehalf`), so "settled" described the CHANNEL rather than the money. Three outcomes
 * existed where the owner describes one:
 *
 *   Call & Assign, ticked      proposedFee = agreedFee = typed      settled
 *   Call & Assign, NOT ticked  proposedFee = typed, agreedFee null  UNSETTLED_FEE, forever
 *   Send to app                proposedFee = quote, agreedFee null  UNSETTLED_FEE, forever
 *
 * That last column is not cosmetic. `bookAssignment` stamps `rate_snapshot.settled = false`, the
 * billing attention query selects on it, and `MoneyPosition` drew each one in danger red as "Fee
 * never agreed" — with no action anywhere that resolves it. Every single "Send to app" job
 * produced one, permanently.
 *
 * There is nothing for a fee to become. Negotiation is gone, and the accept route IGNORES any fee
 * an assayer-caller sends (assignment.controller.ts — otherwise they could re-accept upward via
 * the ACCEPTED self-loop and be paid it). The desk is the only party that can put a number on an
 * assignment, so the desk's number IS the fee. Acceptance stays separate: `acceptOnBehalf` still
 * decides PENDING vs ACCEPTED, because "has somebody said yes" and "what are they paid" are
 * different questions.
 */
describe('the fee is recorded the same way whichever path created it', () => {
  const source = readFileSync(join(__dirname, 'assignment.service.ts'), 'utf8');
  /** The rate card's answer for the walked-through job — same figure the suite above uses. */
  const QUOTE = 1550;

  it('never writes a bare null agreed fee when creating an assignment', () => {
    // Both creation paths (fresh insert, and reuse of a cancelled row) used to do exactly this.
    // A source check because the alternative is standing up the whole create() dependency graph
    // to observe one column; this fails in the file that would reintroduce it.
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /^(assignment\.)?agreedFee\s*[:=]\s*null\s*[,;]?$/.test(line));
    expect(offenders).toEqual([]);
  });

  it('writes the same figure to both columns on creation', () => {
    // proposedFee and agreedFee are set from one expression, so they cannot disagree.
    expect(source).toMatch(/proposedFee:\s*resolvedProposedFee,\s*\n[^\n]*\n\s*agreedFee:\s*resolvedProposedFee\s*\?\?\s*null,/);
    expect(source).toMatch(/assignment\.proposedFee\s*=\s*resolvedProposedFee\s*\?\?\s*null;\s*\n\s*assignment\.agreedFee\s*=\s*resolvedProposedFee\s*\?\?\s*null;/);
  });

  it('keeps acceptance a separate decision from price', () => {
    // If this disappears, "send to app" would start marking jobs accepted that nobody accepted.
    expect(source).toContain('if (!dto.acceptOnBehalf)');
  });

  /**
   * The third path. `create()` and `reassignAssignment()` are both ways an assignment comes to
   * have an assayer, and only the first priced it.
   *
   * Reassignment moved the work to somebody else, nulled `agreedFee`, and left `proposedFee`,
   * `quotedBaseFee`, `quotedTravelFee` and `quotedDistanceKm` describing the person who left —
   * the exact thing `create()`'s reuse branch warns about ("the previous assayer's breakdown
   * must not survive"). A replacement 200 km further out was booked at the original price.
   */
  it('re-prices a reassignment for whoever is now doing the job', () => {
    expect(source).toContain('const repriced = forPricing ? await this.repriceForAssayer(forPricing, newAssayer) : null;');
    for (const column of ['proposedFee', 'agreedFee', 'quotedBaseFee', 'quotedTravelFee', 'quotedDistanceKm']) {
      expect(source).toMatch(new RegExp(`assignment\\.${column} = repriced\\.`));
    }
  });

  it('prices the reassignment before opening the transaction', () => {
    // The re-price reaches an outside road router. Holding a pooled connection across a network
    // call is how a slow dependency becomes pool exhaustion — create() routes outside one too.
    const priceAt = source.indexOf('const repriced = forPricing');
    const txAt = source.indexOf('assignment.agreedFee = repriced.total');
    expect(priceAt).toBeGreaterThan(-1);
    expect(priceAt).toBeLessThan(txAt);
  });

  it('resolves a send-to-app fee to the quote, which is then what gets recorded', () => {
    // The desk names no number on that path, so the rate card's total is the recorded figure —
    // and the planning screen states it before the press (see fee-commitment.spec.ts).
    expect(AssignmentService.resolveProposedFee(undefined, QUOTE)).toBe(QUOTE);
    expect(AssignmentService.resolveProposedFee(null, QUOTE)).toBe(QUOTE);
  });
});
