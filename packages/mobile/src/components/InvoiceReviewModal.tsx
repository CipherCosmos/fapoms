import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { formatRupees as money, formatDateOnly, AssayerInvoiceStatus } from '@fapoms/shared';
import type { AssayerInvoiceInvitation, AssayerInvoiceLine } from '@fapoms/shared';
import { MobileApiService } from '../services/api.service';
import { generateClientRequestId } from '../services/action-queue';
import { displayedTds } from '../screens/earnings-breakdown';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, Divider, Icon } from './ui/primitives';
import { CAT_LABEL_KEYS } from './ExpenseModal';
import { useT } from '../i18n';

/**
 * THE money reveal: the first place in this app an assayer ever sees a fee.
 *
 * Everything about this sheet follows from that one fact:
 *
 *  - It fetches the invitation FRESH every time it opens, and never renders figures handed in
 *    by the screen that opened it. The document being consented to must be the server's current
 *    one, not a copy from a statement loaded minutes ago.
 *  - Submission is a deliberate two-step: the submit button opens a confirmation that restates
 *    the item count and the total, and only the confirmation actually sends. One tap must never
 *    bind somebody to a set of amounts.
 *  - Submission is REQUIRE-ONLINE — a direct awaited call, never the offline action queue. The
 *    submit is consent to the exact figures on screen; a queued replay hours later could land
 *    on an invitation ops has since cancelled and re-issued with different lines, binding the
 *    assayer's name to a document they never read. Offline, the honest answer is "connect and
 *    try again", and that is what the failure copy says.
 *  - The `clientRequestId` is generated once per reviewed document (when the confirm step
 *    opens) and reused for every in-session retry, so a retry after a lost response is
 *    recognised server-side as the submission that already happened — one consent, recorded
 *    once. Reloading the invitation discards it: a fresh document means fresh consent.
 */

type Phase =
  /** Fresh GET in flight. */
  | 'loading'
  /** The GET itself failed — retry is offered; no figures are shown. */
  | 'loadFailed'
  /** No active invitation (or the feature is dark on this server). */
  | 'empty'
  /** The reveal: lines + totals + the first-step submit button. */
  | 'review'
  /** The second step: restated count + total, awaiting the deliberate yes. */
  | 'confirm'
  /** Already submitted — the consented document, readable, awaiting ops approval. */
  | 'submitted';

export interface InvoiceReviewModalProps {
  visible: boolean;
  assayerId: string;
  onClose: () => void;
  /** Called after a successful submit, so the opener can refresh the statement and say so. */
  onSubmitted?: () => void;
}

export const InvoiceReviewModal: React.FC<InvoiceReviewModalProps> = ({
  visible,
  assayerId,
  onClose,
  onSubmitted,
}) => {
  const t = useTheme();
  const tr = useT();

  const [phase, setPhase] = useState<Phase>('loading');
  const [invitation, setInvitation] = useState<AssayerInvoiceInvitation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /**
   * The idempotency key for the CURRENT reviewed document. Generated when the confirm step
   * opens, reused verbatim for every retry while this document stays on screen, and cleared by
   * any reload — see the header comment for why it must never outlive the figures it binds.
   */
  const clientRequestIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setSubmitError(null);
    clientRequestIdRef.current = null;
    try {
      const inv = await MobileApiService.getMyInvoiceInvitation(assayerId);
      if (!inv) {
        setInvitation(null);
        setPhase('empty');
        return;
      }
      setInvitation(inv);
      setPhase(inv.status === AssayerInvoiceStatus.SUBMITTED ? 'submitted' : 'review');
    } catch {
      // Transport failure: "could not ask" must not render as "you have no invitation".
      setInvitation(null);
      setPhase('loadFailed');
    }
  }, [assayerId]);

  // Fresh figures every time the sheet opens — never a reuse of what a previous open fetched.
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  if (!visible) return null;

  const openConfirm = () => {
    // Generated at the press that opens the confirmation, then held: retries of THIS consent
    // must look identical to the server.
    if (!clientRequestIdRef.current) clientRequestIdRef.current = generateClientRequestId();
    setSubmitError(null);
    setPhase('confirm');
  };

  const handleSubmit = async () => {
    if (submitting || !clientRequestIdRef.current) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Direct awaited call, NOT the action queue — see the header comment: consent must bind
      // to the on-screen figures, so it is sent now or not at all.
      const res = await MobileApiService.submitInvoiceInvitation(assayerId, clientRequestIdRef.current);
      if (res.success) {
        setInvitation((prev) =>
          prev ? { ...prev, status: AssayerInvoiceStatus.SUBMITTED, submittedAt: new Date().toISOString() } : prev,
        );
        setPhase('submitted');
        onSubmitted?.();
        return;
      }
      if (res.status === undefined) {
        // The server was never reached. The same clientRequestId is kept for the retry, so a
        // request that DID land before the response was lost is recognised, not duplicated.
        setSubmitError(tr('invoice.submitOffline'));
        return;
      }
      if (res.status === 409) {
        // A different submission already stands (another device, or a stale screen). The only
        // honest move is to reload and show the document's real state.
        setSubmitError(tr('invoice.submitConflict'));
        await load();
        return;
      }
      if (res.status === 404) {
        // The invitation is gone — cancelled, or the feature was switched off. Reload; the
        // empty state explains itself.
        await load();
        return;
      }
      setSubmitError(res.error || tr('invoice.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const scrim = (
    <View
      style={{
        flex: 1,
        backgroundColor: t.colors.scrim,
        justifyContent: 'center',
        padding: t.space.xl,
      }}
    >
      <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, maxHeight: '88%' }}>
        {phase === 'loading' && (
          <View style={{ gap: t.space.md, alignItems: 'center', paddingVertical: t.space.xl }}>
            <Icon name="document-text-outline" size={28} color={t.colors.primary} />
            <AppText variant="caption" tone="muted">{tr('invoice.loading')}</AppText>
          </View>
        )}

        {phase === 'loadFailed' && (
          <View style={{ gap: t.space.lg }}>
            <AppText variant="h2">{tr('invoice.title')}</AppText>
            <AppText variant="small" tone="danger">{tr('invoice.loadFailed')}</AppText>
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <Button label={tr('common.retry')} icon="refresh" onPress={() => void load()} style={{ flex: 1 }} />
              <Button label={tr('common.close')} variant="neutral" onPress={onClose} style={{ flex: 1 }} />
            </View>
          </View>
        )}

        {phase === 'empty' && (
          <View style={{ gap: t.space.lg }}>
            <AppText variant="h2">{tr('invoice.emptyTitle')}</AppText>
            <AppText variant="small" tone="muted">{tr('invoice.emptyBody')}</AppText>
            <Button label={tr('common.close')} variant="neutral" onPress={onClose} full />
          </View>
        )}

        {(phase === 'review' || phase === 'confirm' || phase === 'submitted') && invitation && (
          <>
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                <AppText variant="h2" style={{ flex: 1 }}>{tr('invoice.title')}</AppText>
                {phase === 'submitted' && (
                  <Badge label={tr('invoice.submittedBadge')} tone="info" dot />
                )}
              </View>
              <AppText variant="caption" tone="faint">
                {invitation.invoiceNumber} · {invitation.lineCount === 1
                  ? tr('invoice.itemsOne')
                  : tr('invoice.itemsMany', { count: invitation.lineCount })}
              </AppText>
              {phase !== 'submitted' && (
                <AppText variant="small" tone="muted">{tr('invoice.subtitle')}</AppText>
              )}
            </View>

            {/* The lines stay on screen through review AND confirmation — what is being agreed
                to must be visible at the moment of agreeing to it. */}
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: t.space.sm }}>
              {invitation.lines.map((line) => (
                <InvoiceLineRow key={line.payableId} line={line} />
              ))}
            </ScrollView>

            <Divider spacing={2} />

            {/* Totals — SUMs the server took over the stored payable amounts; nothing here is
                computed on the phone beyond the rounding reconciliation on the TDS print. */}
            <View style={{ gap: 4 }}>
              <TotalRow label={tr('invoice.subtotalBase')} value={money(invitation.subtotalBase)} />
              <TotalRow label={tr('invoice.subtotalTravel')} value={money(invitation.subtotalTravel)} />
              {invitation.tdsAmount > 0 && (
                <TotalRow
                  label={tr('invoice.tdsDeducted')}
                  value={`-${money(displayedTds(invitation.subtotalBase, invitation.subtotalTravel, invitation.totalAmount))}`}
                />
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                <AppText variant="bodyStrong" style={{ flex: 1 }}>{tr('invoice.total')}</AppText>
                <AppText variant="h2" tone="accent">{money(invitation.totalAmount)}</AppText>
              </View>
            </View>

            {submitError ? (
              <AppText variant="small" tone="danger">{submitError}</AppText>
            ) : null}

            {phase === 'review' && (
              <View style={{ flexDirection: 'row', gap: t.space.md }}>
                <Button label={tr('invoice.submit')} icon="checkmark-circle-outline" onPress={openConfirm} style={{ flex: 1 }} />
                <Button label={tr('common.close')} variant="neutral" onPress={onClose} style={{ flex: 1 }} />
              </View>
            )}

            {phase === 'confirm' && (
              <View
                style={{
                  gap: t.space.md,
                  padding: t.space.lg,
                  borderRadius: t.radius.md,
                  backgroundColor: t.colors.primarySoft,
                }}
              >
                <AppText variant="bodyStrong">{tr('invoice.confirmTitle')}</AppText>
                <AppText variant="small" tone="muted">
                  {invitation.lineCount === 1
                    ? tr('invoice.confirmBodyOne', { total: money(invitation.totalAmount) })
                    : tr('invoice.confirmBodyMany', { count: invitation.lineCount, total: money(invitation.totalAmount) })}
                </AppText>
                <View style={{ flexDirection: 'row', gap: t.space.md }}>
                  <Button
                    label={submitting ? tr('invoice.submitting') : tr('invoice.confirmCta')}
                    icon="checkmark"
                    loading={submitting}
                    disabled={submitting}
                    onPress={handleSubmit}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={tr('invoice.confirmBack')}
                    variant="neutral"
                    disabled={submitting}
                    onPress={() => setPhase('review')}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            )}

            {phase === 'submitted' && (
              <View style={{ gap: t.space.md }}>
                <AppText variant="small" tone="muted">{tr('invoice.submittedNote')}</AppText>
                <Button label={tr('common.close')} variant="neutral" onPress={onClose} full />
              </View>
            )}
          </>
        )}
      </Card>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {scrim}
    </Modal>
  );
};

/**
 * One line of the invoice: which job (or which claim), when, and the money — base + travel,
 * TDS, and the net the assayer is billing. Amount leads on the right the way the earnings
 * payout rows read; the FEE/EXPENSE badge says what kind of line this is, because expense
 * reimbursements ride the same invoice as labelled lines.
 */
const InvoiceLineRow: React.FC<{ line: AssayerInvoiceLine }> = ({ line }) => {
  const t = useTheme();
  const tr = useT();
  const isExpense = line.kind === 'EXPENSE' || !!line.expenseCategory;
  const categoryKey = line.expenseCategory
    ? CAT_LABEL_KEYS[line.expenseCategory as keyof typeof CAT_LABEL_KEYS]
    : undefined;
  const kindLabel = isExpense
    ? categoryKey
      ? `${tr('invoice.lineExpense')} · ${tr(categoryKey)}`
      : tr('invoice.lineExpense')
    : tr('invoice.lineFee');

  return (
    <View
      style={{
        gap: 6,
        padding: t.space.md,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: t.colors.border,
        backgroundColor: t.colors.surfaceAlt,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {line.branchName || line.assignmentNumber || line.payableNumber}
          </AppText>
          <AppText variant="caption" tone="faint" numberOfLines={1}>
            {kindLabel}
            {line.serviceDate
              ? ` · ${formatDateOnly(line.serviceDate, { day: 'numeric', month: 'short', year: 'numeric' })}`
              : ''}
          </AppText>
        </View>
        <AppText variant="bodyStrong">{money(line.totalAmount)}</AppText>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <AppText variant="caption" tone="faint">{tr('earnings.base', { amount: money(line.baseAmount) })}</AppText>
        <AppText variant="caption" tone="faint">{tr('earnings.travel', { amount: money(line.travelAmount) })}</AppText>
        {line.tdsAmount > 0 && (
          // Same rounding reconciliation as the earnings payout rows: the printed parts must
          // sum to the printed total. See `displayedTds`.
          <AppText variant="caption" tone="faint">
            {tr('earnings.tds', { amount: money(displayedTds(line.baseAmount, line.travelAmount, line.totalAmount)) })}
          </AppText>
        )}
      </View>
    </View>
  );
};

const TotalRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
    <AppText variant="caption" tone="muted" style={{ flex: 1 }}>{label}</AppText>
    <AppText variant="caption">{value}</AppText>
  </View>
);
