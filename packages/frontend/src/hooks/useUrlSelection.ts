import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * FAPOMS — "which row am I working on", kept in the URL.
 *
 * ## Why this exists
 *
 * Selecting a branch or an assignment is not a passing UI detail; it is the operator's place in
 * their own work. It has to survive a refresh, a trip to another screen and back, and being sent
 * to a colleague in a message. That means it belongs in the URL, and only in the URL — a copy in
 * `useState` is a second source of truth that the address bar will eventually contradict.
 *
 * Three pages had already reached for the URL and each got a different part of it wrong:
 *
 *  - `Assignments` and `Branches` wrote the selection with
 *    `navigate('/assignments?id=' + id)`, which **builds a fresh query string and discards
 *    everything already in it**. Measured in the browser: arriving at
 *    `?status=COMPLETED&page=2&region=WEST` and clicking one row left `?id=47b9ddc2…` — the
 *    status filter, the page and the global scope all gone. Refreshing then reloaded an
 *    unfiltered page 1, on which the selected row often was not present at all, so the operator
 *    had to find it again. That is the whole complaint, and it is a one-line cause.
 *  - `PlanningWorkspace` and `ExecutiveMap` never wrote the selected branch anywhere, so a
 *    refresh simply lost it.
 *
 * ## The two decisions worth stating
 *
 * **Every other parameter is preserved.** `setSearchParams` is given a mutated copy of the
 * current params rather than a new object. Anything a page keeps in the URL — filters, paging,
 * the header's scope — survives a selection change, which is exactly what was broken.
 *
 * **`replace`, not `push`.** Choosing a row is not navigating; it changes what a panel shows.
 * Pushing would make the browser's Back button walk backwards through every row the operator
 * clicked before it left the page, which is worse than useless on a list someone is scanning.
 * With `replace`, Back means "leave this screen" and the address bar still carries the selection
 * for a refresh or a paste into chat.
 *
 * Clearing passes `null`, which removes the key rather than writing the string "null".
 */
export function useUrlSelection(
  key = 'id',
): [string | null, (id: string | null) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get(key);

  const select = useCallback(
    (id: string | null) => {
      setSearchParams(
        (current) => {
          // A copy of what is already there — the bug this hook exists for was replacing it.
          const next = new URLSearchParams(current);
          if (id) next.set(key, id);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [key, setSearchParams],
  );

  return [selected, select];
}
