import type { ActionKind, QueuedAction } from '../services/action-queue';
import { t, type TranslationKey } from './i18n';
import { serverErrorText } from './server-errors';

/**
 * The words for an action the server refused after the assayer had been told it was saved on the
 * phone ("it will send by itself"): which action, and the server's reason — translated by its code
 * when the app knows the code, the server's own sentence otherwise. One place, so the banner and
 * the local notification cannot say it differently.
 */
export interface RefusalNotice {
  /** "Your check-in". */
  what: string;
  /** The server's reason, translated where possible. */
  reason: string;
  /** Notification title: "Your check-in was not accepted". */
  title: string;
  /** One line for the banner: "Your check-in: <reason>". */
  line: string;
}

const KIND_KEYS: Record<ActionKind, TranslationKey> = {
  CHECK_IN: 'queue.kinds.CHECK_IN',
  CHECK_OUT: 'queue.kinds.CHECK_OUT',
  ASSIGNMENT_STATUS: 'queue.kinds.ASSIGNMENT_STATUS',
  EXPENSE_CLAIM: 'queue.kinds.EXPENSE_CLAIM',
  QUERY_MESSAGE: 'queue.kinds.QUERY_MESSAGE',
};

export function refusalNotice(entry: Pick<QueuedAction, 'kind' | 'error' | 'code'>): RefusalNotice {
  const what = t(KIND_KEYS[entry.kind] ?? 'queue.refusedTitle');
  const reason = serverErrorText(entry.error, 'queue.refusedFallback', entry.code);
  return {
    what,
    reason,
    title: t('queue.refusedNotifyTitle', { what }),
    line: t('queue.refusedLine', { what, reason }),
  };
}
