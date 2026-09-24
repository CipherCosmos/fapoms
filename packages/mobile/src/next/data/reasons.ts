/**
 * The words for "why not" on a job action, and for an action the office refused — chosen by the
 * server's machine code. Pure, for the node tests.
 *
 * Rule: in English the server's own sentence wins when there is one (it names the date, the
 * distance). In any other language a known code gets its translated sentence, because an accurate
 * sentence the assayer can read beats a specific one they cannot. An unknown code keeps the
 * server's sentence; with no sentence at all, the caller's fallback.
 */
import { CATALOGUES, type TranslationKey } from '../i18n/catalogues';
import type { AppLanguage } from '../i18n/languages';
import { lookup, type CatalogueNode } from '../i18n/translate';
import type { ActionKind, QueuedAction } from '../../services/action-queue';

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function knownReasonKey(code: string | undefined): TranslationKey | null {
  if (!code) return null;
  const key = `work.reasons.${code}`;
  return lookup(CATALOGUES.en as unknown as CatalogueNode, key) !== undefined ? (key as TranslationKey) : null;
}

export function reasonText(
  t: Translate,
  language: AppLanguage,
  code: string | undefined,
  serverSentence: string | undefined,
  fallback: TranslationKey,
): string {
  const sentence = serverSentence?.trim() && serverSentence.trim() !== code ? serverSentence.trim() : undefined;
  const key = knownReasonKey(code);
  if (key && (language !== 'en' || !sentence)) return t(key);
  return sentence ?? t(fallback);
}

const KIND_KEYS: Record<ActionKind, TranslationKey> = {
  CHECK_IN: 'queue.kinds.CHECK_IN',
  CHECK_OUT: 'queue.kinds.CHECK_OUT',
  ASSIGNMENT_STATUS: 'queue.kinds.ASSIGNMENT_STATUS',
  EXPENSE_CLAIM: 'queue.kinds.EXPENSE_CLAIM',
  QUERY_MESSAGE: 'queue.kinds.QUERY_MESSAGE',
};

/** Title, reason and one-line summary for a refused queued action (banner and notification). */
export function refusalWords(
  t: Translate,
  language: AppLanguage,
  entry: Pick<QueuedAction, 'kind' | 'error' | 'code'>,
): { what: string; reason: string; title: string; line: string } {
  const what = t(KIND_KEYS[entry.kind] ?? 'queue.title');
  const reason = reasonText(t, language, entry.code, entry.error, 'queue.fallback');
  return { what, reason, title: t('queue.notifyTitle', { what }), line: t('queue.line', { what, reason }) };
}
