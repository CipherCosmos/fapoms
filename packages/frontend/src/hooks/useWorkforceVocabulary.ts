import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * The skills and certifications that actually exist on the roster.
 *
 * `GET /assayers/workforce-attribute/vocabulary` is the same list the HR capability page
 * writes and the branch and project forms already pick from. Every screen that fetched it
 * did so with its own `useEffect`, its own de-dupe and its own sort; this is that one fetch.
 *
 * Why it matters: these values feed the matching engine by exact string comparison. A typo is
 * never rejected — "Gold Valuar" simply becomes a requirement nobody on the roster holds, so
 * the branch quietly matches nobody and the coordinator sees an empty candidate list with no
 * hint that a misspelling caused it.
 *
 * `null` means "still loading". An empty array means the HR-scoped endpoint is not readable by
 * this role (or is unavailable), in which case callers must fall back to their free-text input
 * rather than leaving no way to record a requirement at all.
 */
export interface WorkforceVocabulary {
  skills: string[] | null;
  certifications: string[] | null;
}

const clean = (list?: { name: string }[]) =>
  Array.from(new Set((list ?? []).map((x) => x.name).filter(Boolean))).sort((a, b) => a.localeCompare(b));

export function useWorkforceVocabulary(): WorkforceVocabulary {
  const [skills, setSkills] = useState<string[] | null>(null);
  const [certifications, setCertifications] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .request<{ SKILL?: { name: string }[]; CERTIFICATION?: { name: string }[] }>('/assayers/workforce-attribute/vocabulary')
      .then((v) => {
        if (cancelled) return;
        setSkills(clean(v?.SKILL));
        setCertifications(clean(v?.CERTIFICATION));
      })
      .catch(() => {
        if (cancelled) return;
        setSkills([]);   // not permitted / unavailable → callers fall back to free text
        setCertifications([]);
      });
    return () => { cancelled = true; };
  }, []);

  return { skills, certifications };
}

/** Convenience for a field that accepts either kind of competency. */
export function asOptions(names: string[] | null): { value: string; label: string }[] {
  return (names ?? []).map((n) => ({ value: n, label: n }));
}
