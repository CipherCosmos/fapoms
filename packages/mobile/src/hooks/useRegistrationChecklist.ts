import { useCallback, useEffect, useState } from 'react';
import { MobileApiService, type RegistrationChecklist } from '../services/api.service';

/**
 * The assayer's own registration paperwork, as the app sees it.
 *
 * Deliberately quiet about failure. This is an optional accelerator — HR can complete a
 * registration end to end from the desk without the worker's phone ever being involved — so a
 * checklist that will not load must degrade to *nothing on screen*, never to an error the person
 * has to dismiss before they can get to their actual work. `checklist` stays null and every
 * caller treats null as "no banner, no prompt, no nagging".
 *
 * There is no polling. The list changes when the person uploads something, and the upload path
 * calls `reload` itself; a background poll would spend a field worker's data allowance to
 * re-learn something the app already knows.
 */
export interface RegistrationChecklistState {
  checklist: RegistrationChecklist | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useRegistrationChecklist(enabled: boolean): RegistrationChecklistState {
  const [checklist, setChecklist] = useState<RegistrationChecklist | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setChecklist(await MobileApiService.getRegistrationChecklist());
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    // Cleared on sign-out as well as loaded on sign-in: on a shared handset the next person to
    // log in must not see the last person's outstanding paperwork for even one frame.
    if (!enabled) {
      setChecklist(null);
      return;
    }
    void reload();
  }, [enabled, reload]);

  return { checklist, loading, reload };
}
