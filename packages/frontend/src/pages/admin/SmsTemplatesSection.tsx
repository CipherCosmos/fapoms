import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, CheckCircle2, Copy, MessageSquare, RotateCcw, Send, XCircle } from 'lucide-react';
import {
  DLT_ID_PATTERN, countSmsSegments, fillSmsTemplate, smsWordingProblems, toDltForm, toE164IndianMobile,
} from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useToast, Modal, useConfirm } from '../../components/ui';
import { SectionCard, Pill, controlStyle } from '../../components/ui/settings';
import { SkeletonList } from '../../components/ui/Loading';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { TemplateStudioHeader, TemplatePicker, TemplateDetailBar, CommonTokenChips } from './TemplateStudio';

/**
 * Text messages on the Platform Settings screen: the delivery card (the SMS twin of the email status
 * card) and the wording of every text.
 *
 * Written for the person who holds the company's DLT registration, not for an engineer. In India
 * every business text must match, word for word, a template registered on the DLT portal and carry
 * the id the portal gave it — so the screen's job is to hand them exactly what to register, show what
 * a phone will receive and what it costs, and refuse wording that would send a code message without
 * its code. The counting, DLT form and checks are the server's own rules from `@fapoms/shared`, so
 * what this screen shows is what is sent.
 *
 * It is built out of the same pieces as the email templates screen (`TemplateStudio.tsx`) — pick one
 * from a grid, then work on that one — because it is the same job on a different channel, and the
 * owner asked for the two to feel like one product.
 */

export interface SmsStatus {
  enabled: boolean;
  provider: string | null;
  senderId: string | null;
  dltEntityIdSet: boolean;
  hint: string | null;
}

export interface SmsTemplateRow {
  key: string;
  name: string;
  description: string;
  defaultText: string;
  dltForm: string;
  requiredTokens: string[];
  sampleData: Record<string, string>;
  overrideText: string | null;
  /** The id in force: this administrator's, or the one that ships with the standard wording. */
  dltTemplateId: string | null;
  /** Only what was typed here. The box below shows THIS one — see the comment beside it. */
  savedDltTemplateId: string | null;
  dltTemplateIdIsBuiltIn: boolean;
  overrideRejected: boolean;
  preview: string;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
}

const SMALL: React.CSSProperties = { fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', lineHeight: 1.5 };
const LABEL: React.CSSProperties = { fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)' };
const WARN: React.CSSProperties = { display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: 'var(--text-2xs)', color: 'var(--warning)', lineHeight: 1.5 };
const BOX: React.CSSProperties = {
  padding: '10px 12px', borderRadius: '6px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
  fontSize: 'var(--text-sm)', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
};

// ── Delivery card ────────────────────────────────────────────────────────────────────────────────

/** Whether texts can leave, and a way to prove it — shown at the top of the SMS delivery section. */
/** The company's name as people write it, from the code the server answers with. */
function smsCompanyLabel(provider: string | null | undefined): string {
  if (!provider) return 'gateway';
  return provider === 'PINNACLE' ? 'Pinnacle' : provider;
}

/** The one place the screen asks whether texts can go out — shared by the card and the templates. */
const SMS_STATUS_KEY = ['notification-admin', 'sms-status'];
const useSmsStatus = () => useQuery({
  queryKey: SMS_STATUS_KEY,
  queryFn: () => api.request<SmsStatus>('/notification-admin/sms/status'),
});

export const SmsDeliveryCard: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const { toast } = useToast();
  const [to, setTo] = useState('');
  const [testing, setTesting] = useState(false);

  const statusQuery = useSmsStatus();
  const status = statusQuery.data ?? null;
  /** Not "SMS is off" — "we did not get to ask". */
  const unknown = loadFailed(statusQuery);
  const numberLooksWrong = to.trim() !== '' && !toE164IndianMobile(to);

  const sendTest = async () => {
    setTesting(true);
    try {
      // A gateway refusal comes back in the payload, not as an HTTP error: the request worked, the
      // gateway said no, and its reason is what the person needs to read.
      const r = await api.request<{ success?: boolean; error?: string }>(
        '/notification-admin/sms/test',
        { method: 'POST', body: JSON.stringify({ to }) },
      );
      if (r?.success === false) toast({ type: 'error', title: 'The SMS gateway refused it', message: r.error ?? 'Unknown error' });
      else toast('success', `Test text sent to ${to}.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not send', message: userMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const title = unknown
    ? 'Whether SMS is working could not be read'
    : status?.enabled
      ? `SMS is working — ${smsCompanyLabel(status.provider)}`
      : 'SMS is not set up';
  const description = unknown
    ? 'The delivery status did not load, so this section cannot say whether texts are going out. The fields below are still the saved configuration.'
    : status?.enabled
      ? `Texts arrive from ${status.senderId}.${status.dltEntityIdSet ? ' Your DLT Principal Entity ID is set, so every text also needs its DLT Template ID (see Email Templates → Text messages).' : ''}`
      : 'One-time codes and sign-in details go by email only until it is. Fill in the fields below to switch it on.';

  return (
    <SectionCard
      icon={unknown ? <AlertTriangle size={16} /> : status?.enabled ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      title={title}
      description={description}
    >
      {!unknown && status?.hint && (
        <div style={{ ...WARN, marginBottom: '10px' }} role="note">
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden /> {status.hint}
        </div>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="tel" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Mobile number for the test text"
            placeholder="Send a test text to… (10-digit mobile)" style={{ ...controlStyle, width: '260px' }}
          />
          <button
            className="btn btn-secondary" disabled={testing || !to.trim() || numberLooksWrong || !status?.enabled}
            onClick={sendTest}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '8px 14px' }}
          >
            <Send size={13} /> {testing ? 'Sending…' : 'Send test text'}
          </button>
          <span style={SMALL}>
            {numberLooksWrong
              ? 'That does not look like an Indian mobile number — 10 digits, starting 6 to 9.'
              : 'A real text, to a real phone — the only way to know the gateway accepts these details.'}
          </span>
          <Link
            to="/admin/settings?group=email_templates"
            style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--accent)', textDecoration: 'none', marginLeft: 'auto' }}
          >
            Wording and DLT Template IDs →
          </Link>
        </div>
      )}
    </SectionCard>
  );
};

// ── Templates ────────────────────────────────────────────────────────────────────────────────────

/** The live cost line under a text: characters, parts, and why a text is costing more than it looks. */
export function smsCostLine(text: string): string {
  const c = countSmsSegments(text);
  const parts = `${c.segments} SMS ${c.segments === 1 ? 'part' : 'parts'}`;
  if (c.encoding === 'UCS-2') {
    return `${c.length} characters · ${parts} · contains a special character (like ₹, a curly quote or a non-English letter), so only ${c.perSegment} characters fit per part`;
  }
  return `${c.length} characters · ${parts} · up to ${c.perSegment} characters per part`;
}

/**
 * Why this text cannot be sent yet, in one sentence — or null when it can.
 *
 * These are the two refusals the server already makes, said before the button is pressed rather
 * than after. The second one is the expensive one: the gateway is configured, everything looks
 * healthy, and this one text is dropped by every phone company because nobody pasted its id.
 */
export function smsSendBlock(row: SmsTemplateRow, status: SmsStatus | null): string | null {
  if (!status) return null;
  if (!status.enabled) {
    return 'SMS is not set up yet, so no text can be sent. Switch it on under SMS delivery first.';
  }
  if (status.dltEntityIdSet && !row.dltTemplateId) {
    return `"${row.name}" has no DLT Template ID yet. Your DLT Principal Entity ID is set, so phone companies will block this text. `
      + 'Register the wording shown below on your DLT portal, paste the ID it gives back, and save.';
  }
  return null;
}

const SmsTemplateEditor: React.FC<{
  row: SmsTemplateRow;
  canEdit: boolean;
  /** The sentence that stops this text going out, if there is one. */
  blocked: string | null;
}> = ({ row, canEdit, blocked }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const savedText = row.overrideText ?? row.defaultText;
  /*
    The box shows the id somebody TYPED here, not the id in force.

    When the wording that ships with the platform was registered on DLT for us, its id comes down
    with it — and putting that in the box would mean the next save records it as this administrator's
    own, still attached after they have rewritten every word of the text. The id would then be sent
    with wording it was never registered for, which is what gets a sender header suspended. So the
    built-in id is shown as a sentence under the box instead, and only a typed id lives in it.
  */
  const savedId = row.savedDltTemplateId ?? '';
  const [text, setText] = useState(savedText);
  const [dltId, setDltId] = useState(savedId);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // A save (or another administrator's) refreshes the row; the editor follows it.
  useEffect(() => { setText(savedText); }, [savedText]);
  useEffect(() => { setDltId(savedId); }, [savedId]);

  const wordingProblems = text.trim() ? smsWordingProblems(text, row.requiredTokens) : ['Write the wording, or press "Use the standard wording".'];
  const idProblem = dltId.trim() && !DLT_ID_PATTERN.test(dltId.trim())
    ? 'A DLT Template ID is digits only — copy it exactly from your DLT portal.'
    : null;
  const dirty = text !== savedText || dltId.trim() !== savedId;
  const canSave = canEdit && dirty && wordingProblems.length === 0 && !idProblem && !saving;
  /** The id on file was registered for the old wording; new wording needs a new registration. */
  const wordingChangedUnderSameId = text.trim() !== savedText.trim() && !!savedId && dltId.trim() === savedId;
  const dltForm = toDltForm(text.trim());
  const preview = fillSmsTemplate(text.trim(), row.sampleData);

  const save = async () => {
    setSaving(true);
    try {
      await api.request(`/notification-admin/sms-templates/${row.key}`, {
        method: 'PUT',
        body: JSON.stringify({
          text: text.trim() === row.defaultText ? null : text.trim(),
          dltTemplateId: dltId.trim() || null,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['notification-admin', 'sms-templates'] });
      toast('success', `"${row.name}" saved.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not save', message: userMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const copyDltForm = async () => {
    try {
      await navigator.clipboard.writeText(dltForm);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ type: 'warning', title: 'Could not copy', message: 'Select the text in the box and copy it by hand.' });
    }
  };

  return (
    <section
      aria-label={row.name}
      className="glass-card"
      style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      {blocked && (
        <div style={WARN} role="note">
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden /> {blocked}
        </div>
      )}

      {row.overrideRejected && (
        <div style={WARN} role="note">
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden />
          The saved wording is missing a value it needs, so the standard wording is being sent instead. Fix it below and save.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={LABEL} htmlFor={`sms-text-${row.key}`}>Wording</label>
          <textarea
            id={`sms-text-${row.key}`} aria-label={`${row.name} wording`}
            value={text} disabled={!canEdit || saving} rows={4}
            onChange={(e) => setText(e.target.value)}
            style={{ ...controlStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <div style={SMALL} aria-label={`${row.name} length`}>{smsCostLine(preview)}</div>
          <div style={SMALL}>
            Filled in when sent: {row.requiredTokens.map((t) => <code key={t} style={{ marginRight: '6px' }}>{`{{${t}}}`}</code>)}
            — keep each one, exactly as written.
          </div>
          {/*
            And the values every message carries, offered exactly as the email screen offers them —
            one component, so the two screens cannot describe the same placeholder differently.
            Clicking one appends it: a text is four lines, so there is no cursor to insert at the
            way the HTML editor has one.
          */}
          {canEdit && (
            <CommonTokenChips
              onInsert={(token) => setText((current) => `${current}${current.endsWith(' ') || !current ? '' : ' '}{{${token}}}`)}
              overriddenBy={row.requiredTokens}
              label="Also available"
            />
          )}
          {wordingProblems.map((p) => (
            <div key={p} style={WARN} role="alert">
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden /> {p}
            </div>
          ))}
          {text.trim() !== row.defaultText && (
            <div style={SMALL}>
              Standard wording: <span style={{ color: 'var(--text-secondary)' }}>{row.defaultText}</span>{' '}
              {canEdit && (
                <button
                  type="button" className="btn btn-secondary" onClick={() => setText(row.defaultText)}
                  style={{ padding: '2px 8px', fontSize: 'var(--text-3xs)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <RotateCcw size={10} /> Use the standard wording
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={LABEL}>What the phone shows (with example values)</span>
          <div style={BOX} aria-label={`${row.name} preview`}>{preview || '—'}</div>

          <span style={{ ...LABEL, marginTop: '4px' }}>Register exactly this on your DLT portal</span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
            <div style={{ ...BOX, flex: 1, fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--text-xs)' }} aria-label={`${row.name} DLT form`}>
              {dltForm}
            </div>
            <button type="button" className="btn btn-secondary" onClick={copyDltForm} title="Copy" style={{ padding: '6px 9px' }}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <div style={SMALL}>Each {'{#var#}'} is where a value goes. The portal gives back a Template ID — paste it below.</div>

          <label style={{ ...LABEL, marginTop: '4px' }} htmlFor={`sms-dlt-${row.key}`}>DLT Template ID</label>
          <input
            id={`sms-dlt-${row.key}`} aria-label={`${row.name} DLT Template ID`} inputMode="numeric"
            value={dltId} disabled={!canEdit || saving} placeholder="e.g. 1107160000000012345"
            onChange={(e) => setDltId(e.target.value)} style={controlStyle}
          />
          {row.dltTemplateIdIsBuiltIn && !dltId.trim() && (
            <div style={SMALL}>
              This text already has a registered Template ID (<code>{row.dltTemplateId}</code>), supplied with the
              platform for the standard wording above. Leave this empty to keep using it. If you change the wording,
              register the new wording and paste its own ID here.
            </div>
          )}
          {idProblem && (
            <div style={WARN} role="alert">
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden /> {idProblem}
            </div>
          )}
          {row.dltTemplateIdIsBuiltIn && text.trim() !== row.defaultText && !dltId.trim() && (
            <div style={WARN} role="alert">
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden />
              The registered Template ID belongs to the standard wording, so it will not be used for what you have
              written. Register this wording on your DLT portal and paste its ID here, or the text will be refused.
            </div>
          )}
          {wordingChangedUnderSameId && (
            <div style={WARN} role="note">
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden />
              You changed the wording, but this Template ID was registered for the old wording. Register the new wording
              on your DLT portal and paste its new ID here — otherwise phone companies will block this text.
            </div>
          )}
        </div>
      </div>

      {canEdit && (
        <div>
          <button className="btn btn-primary" disabled={!canSave} onClick={save} style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }}>
            {saving ? 'Saving…' : `Save "${row.name}"`}
          </button>
        </div>
      )}
    </section>
  );
};

/** The wording of every text the platform sends, mounted beside the email templates. */
export const SmsTemplatesSection: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();

  const query = useQuery({
    queryKey: ['notification-admin', 'sms-templates'],
    queryFn: () => api.request<SmsTemplateRow[] | { data: SmsTemplateRow[] }>('/notification-admin/sms-templates'),
  });
  /*
    Held steady between renders, not rebuilt inline: the fallback `[]` is a new array every time,
    and the effect below and the card list both watch this. A list that changes identity on every
    render makes both of them run on every render for nothing.
  */
  const rows: SmsTemplateRow[] = useMemo(
    () => (Array.isArray(query.data) ? query.data : (query.data?.data ?? [])),
    [query.data],
  );

  const statusQuery = useSmsStatus();
  const status = loadFailed(statusQuery) ? null : (statusQuery.data ?? null);

  const [selectedKey, setSelectedKey] = useState('');
  const [showTestModal, setShowTestModal] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [sendingTest, setSendingTest] = useState(false);

  // The first text is open when the screen arrives, and stays open unless it goes away.
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.key === selectedKey)) setSelectedKey(rows[0].key);
  }, [rows, selectedKey]);

  const selected = rows.find((r) => r.key === selectedKey) ?? null;
  const blocked = selected ? smsSendBlock(selected, status) : null;
  const numberLooksWrong = testTo.trim() !== '' && !toE164IndianMobile(testTo);

  const items = useMemo(() => rows.map((row) => {
    const needsId = !!status?.dltEntityIdSet && !row.dltTemplateId;
    return {
      key: row.key,
      name: row.name,
      description: row.description,
      badge: `${row.segments} ${row.segments === 1 ? 'part' : 'parts'}`,
      status: needsId
        ? { tone: 'warning' as const, label: 'Cannot send yet — no DLT Template ID' }
        : row.dltTemplateId
          ? { tone: 'success' as const, label: 'DLT Template ID set' }
          : { tone: 'accent' as const, label: 'No DLT Template ID' },
      flag: row.overrideRejected
        ? <Pill tone="warning">Wording not in use</Pill>
        : row.overrideText ? <Pill tone="accent">Edited</Pill> : undefined,
    };
  }), [rows, status]);

  /**
   * Puts one text back to the wording the platform ships with, and forgets its DLT Template ID.
   *
   * The id has to go with it: it was registered against the edited wording, so keeping it would
   * pair the standard wording with somebody else's registration — which every operator blocks.
   * That is worth a sentence in the question, because it is the part nobody expects.
   */
  const restoreDefault = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: `Put "${selected.name}" back to the standard wording?`,
      message: 'The wording you saved is replaced by the wording the platform ships with, and this text\'s DLT Template ID '
        + 'is cleared — that ID was registered for your wording, so it cannot be kept. You will need to register the standard '
        + 'wording on your DLT portal and paste the new ID back in before this text can go out again.',
      // Named so it cannot be confused with the "use the standard wording" button in the editor,
      // which only fills the box in and saves nothing.
      confirmLabel: 'Restore it and clear the ID',
      cancelLabel: 'Keep my wording',
      reversible: true,
      reversibleNote: 'You can type your wording in again afterwards; only the saved copy here is replaced.',
    });
    if (!ok) return;

    try {
      await api.request(`/notification-admin/sms-templates/${selected.key}`, {
        method: 'PUT',
        body: JSON.stringify({ text: null, dltTemplateId: null }),
      });
      await queryClient.invalidateQueries({ queryKey: ['notification-admin', 'sms-templates'] });
      toast('success', `"${selected.name}" is back to the standard wording.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not restore it', message: userMessage(err) });
    }
  };

  /** Sends THIS text to a phone — the wording that is saved, with the example values shown above. */
  const sendTemplateTest = async () => {
    if (!selected) return;
    setSendingTest(true);
    try {
      // Like the delivery card: a gateway refusal arrives in the payload, not as an HTTP error.
      const r = await api.request<{ success?: boolean; error?: string }>(
        `/notification-admin/sms-templates/${selected.key}/test`,
        { method: 'POST', body: JSON.stringify({ to: testTo }) },
      );
      if (r?.success === false) {
        toast({ type: 'error', title: 'The SMS gateway refused it', message: r.error ?? 'Unknown error' });
      } else {
        toast('success', `"${selected.name}" sent to ${testTo}.`);
        setShowTestModal(false);
      }
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not send', message: userMessage(err) });
    } finally {
      setSendingTest(false);
    }
  };

  if (loadFailed(query)) {
    return (
      <SectionCard icon={<MessageSquare size={16} />} title="Text messages (SMS)" description="The wording of every text the platform sends.">
        <LoadFailure loads={[{ label: 'the text message templates', query }]} />
      </SectionCard>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {confirmDialog}

      <TemplateStudioHeader
        icon={<MessageSquare size={20} />}
        title="Text message (SMS) studio"
        description="The wording of every text the platform sends. In India each business text must match a template registered on your DLT portal, word for word. Pick a text below: register the DLT form it shows, paste the Template ID the portal gives you, and save."
        actions={canEdit && selected && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowTestModal(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '7px 12px' }}
          >
            <Send size={13} />
            Send this text to a phone
          </button>
        )}
      >
        {query.isLoading ? (
          <SkeletonList rows={3} height={60} />
        ) : (
          <TemplatePicker
            label="Text messages to choose from"
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            items={items}
          />
        )}
      </TemplateStudioHeader>

      {selected && (
        <>
          <TemplateDetailBar
            icon={<MessageSquare size={18} />}
            name={selected.name}
            itemKey={selected.key}
            footnote={selected.description}
            pills={(
              <>
                {selected.overrideText ? <Pill tone="accent">Edited wording</Pill> : <Pill>Standard wording</Pill>}
                {selected.dltTemplateId ? <Pill tone="success">DLT Template ID set</Pill> : <Pill tone="warning">No DLT Template ID</Pill>}
              </>
            )}
            actions={canEdit && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={restoreDefault}
                disabled={!selected.overrideText && !selected.savedDltTemplateId}
                title={!selected.overrideText && !selected.savedDltTemplateId
                  ? 'This text is already the standard wording, with nothing saved over it.'
                  : 'Replace the saved wording with the wording the platform ships with'}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '6px 12px', fontWeight: 600 }}
              >
                <RotateCcw size={13} />
                Restore the standard wording
              </button>
            )}
          />

          <SmsTemplateEditor key={selected.key} row={selected} canEdit={canEdit} blocked={blocked} />
        </>
      )}

      {showTestModal && selected && (
        <Modal open={showTestModal} title={`Send a test: ${selected.name}`} onClose={() => setShowTestModal(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: '380px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              A real text, to a real phone. It goes out with the wording that is <strong>saved</strong> for this text and the
              example values shown in the preview — so if you have just changed the wording, save it first.
            </div>

            {blocked && (
              <div style={WARN} role="alert">
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden /> {blocked}
              </div>
            )}

            <div>
              <label style={{ display: 'block', ...LABEL, marginBottom: '6px' }} htmlFor="sms-template-test-to">
                Mobile number
              </label>
              <input
                id="sms-template-test-to"
                type="tel"
                aria-label="Mobile number for this test text"
                placeholder="10-digit mobile"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                style={controlStyle}
              />
              <div style={{ ...SMALL, marginTop: '6px' }}>
                {numberLooksWrong
                  ? 'That does not look like an Indian mobile number — 10 digits, starting 6 to 9.'
                  : 'An Indian mobile number — 10 digits, starting 6 to 9.'}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowTestModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={sendingTest || !testTo.trim() || numberLooksWrong || !!blocked}
                onClick={sendTemplateTest}
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <Send size={13} />
                {sendingTest ? 'Sending…' : 'Send this text'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default SmsTemplatesSection;
