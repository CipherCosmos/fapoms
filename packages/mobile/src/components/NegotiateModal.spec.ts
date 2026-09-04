import * as fs from 'fs';
import * as path from 'path';

/**
 * The counter-fee box is deliberately pre-filled with the real travel figure on the table (see
 * `feeText`'s init in `NegotiateModal.tsx`), not a placeholder — an assayer who submits it
 * unedited is understood to be repeating the current offer. That design choice is exactly what
 * makes an unguarded input dangerous: tapping in and typing a new number without first clearing
 * the old one does not replace it, it appends to it.
 *
 * Proven live against the real backend: an assignment sitting at a desk counter of ₹2,200 was
 * countered again by typing "2600" straight into the pre-filled box. The two numbers concatenated
 * — ₹22,002,600 — and nothing on either the client or the server caught it; it was accepted as a
 * genuine PENDING counter-offer.
 *
 * The assertions are structural, in this suite's established style (see
 * `chunk-upload-contract.spec.ts`), because there is no React Native renderer here to focus a
 * real `TextInput` and inspect its selection. What can be checked is that the prop which makes a
 * focus select-all rather than append-at-cursor is present on the amount field specifically, and
 * only there — the remarks box starts empty every time the sheet opens, so it carries none of
 * this risk and should not be affected by the same fix landing in the wrong place.
 */
describe('NegotiateModal amount field — pre-filled value cannot be silently appended to', () => {
  const source = fs.readFileSync(path.join(__dirname, 'NegotiateModal.tsx'), 'utf8');

  const amountField = (() => {
    const start = source.indexOf('keyboardType="number-pad"');
    expect(start).toBeGreaterThan(-1);
    // Back up to the enclosing <TextInput, forward to its closing />.
    const openTag = source.lastIndexOf('<TextInput', start);
    const close = source.indexOf('/>', start);
    return source.slice(openTag, close);
  })();

  const remarksField = (() => {
    const start = source.indexOf('multiline');
    expect(start).toBeGreaterThan(-1);
    const openTag = source.lastIndexOf('<TextInput', start);
    const close = source.indexOf('/>', start);
    return source.slice(openTag, close);
  })();

  it('is seeded from the real travel-on-the-table value, not left blank', () => {
    // The whole reason this field needs guarding: it starts non-empty.
    expect(source).toMatch(/const \[feeText, setFeeText\] = useState\(\s*travelOnTable/);
  });

  it('selects the pre-filled amount on focus, so the first keystroke replaces it', () => {
    expect(amountField).toMatch(/selectTextOnFocus/);
  });

  it('does not apply the same auto-select to the remarks box', () => {
    // Remarks always opens empty (`useState('')`, re-seeded to '' on every open) — auto-selecting
    // nothing is a no-op at best, and copying the prop there by habit would be worth questioning.
    expect(remarksField).not.toMatch(/selectTextOnFocus/);
  });
});
