import { useCallback, useMemo, useState } from 'react';
import { MobileApiService } from '../services/api.service';
import { useFeedback } from '../components/ui/Feedback';
import type { ProfileDataState } from '../screens/ProfileScreen';
import type { LeavePeriod } from '../components/AvailabilityModal';

/**
 * The assayer's own record: their details, their pay totals, and the days they are unavailable.
 *
 * Every field starts blank rather than plausible. A New Delhi default for latitude/longitude
 * silently became the stored home location for workers who never edited the field, which then
 * fed travel-distance and routing calculations — a confident, entirely fabricated answer is worse
 * here than an obviously missing one.
 */
/**
 * The fields the assayer actually edited this session, as a partial update.
 *
 * Everything the screen holds but did not change is left out entirely, so the server applies a
 * genuine PATCH rather than re-asserting the whole record. Two details matter:
 *
 *  - Coordinates move as a PAIR. `latitude` and `longitude` describe one fact, and the API
 *    ignores a lone one; sending half a pin would silently do nothing while the screen showed
 *    the new position.
 *  - Comparison is on the value, not the reference, and normalised to string for scalars, since
 *    a numeric input round-trips `10` as `'10'` and would otherwise look edited on every save.
 */
/**
 * The only profile keys this screen may ever send, under their local names.
 *
 * Everything else `ProfileDataState` holds is either the server's to state (earnings, ratings,
 * assignment counts) or HR's (PAN, bank, joining date, workload caps). The API enforces that with
 * an ALL-OR-NOTHING check — one non-self-editable field anywhere in the body and the whole
 * request is refused with 403, so a single stray key would turn "I changed my phone number" into
 * "nothing I do ever saves". Listing what may go keeps that impossible by construction rather
 * than by everyone remembering.
 *
 * Local names, because that is what the screen's state uses; `updateAssayerProfile` translates
 * them to the API's (`emergencyName` → `emergencyContactName`). Kept in step with
 * SELF_EDITABLE_ASSAYER_FIELDS by `self-editable-fields.spec`.
 */
const SENDABLE_PROFILE_KEYS = [
  'phone', 'alternatePhone', 'email',
  'address', 'city', 'district', 'state', 'pincode',
  'latitude', 'longitude',
  'emergencyName', 'emergencyPhone', 'emergencyRelation',
  'skills', 'languages', 'preferredRegions', 'experienceYears',
] as const;

export function changedFields(
  next: Record<string, any>,
  base: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  const same = (a: any, b: any) => {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a ?? '') === String(b ?? '');
  };

  for (const key of SENDABLE_PROFILE_KEYS) {
    if (key === 'latitude' || key === 'longitude') continue;
    if (!same(next[key], base[key])) out[key] = next[key];
  }

  if (!same(next.latitude, base.latitude) || !same(next.longitude, base.longitude)) {
    out.latitude = next.latitude;
    out.longitude = next.longitude;
  }

  return out;
}

function emptyProfile(seed: { assayerCode?: string; latitude?: number; longitude?: number }): ProfileDataState {
  return {
    phone: '',
    alternatePhone: '',
    email: '',
    address: '',
    city: '',
    state: '',
    district: '',
    pincode: '',
    latitude: seed.latitude ?? 0,
    longitude: seed.longitude ?? 0,
    preferredRegions: '',
    preferredRadius: 10,
    languages: '',
    licenseNo: '',
    emergencyName: '',
    emergencyPhone: '',
    emergencyRelation: '',
    skills: '',
    experienceYears: 0,
    panNumber: '',
    bankAccountNumber: '',
    ifscCode: '',
    // Read-only, and here only so the record-completeness banner can see it. It is one of the
    // seven fields the back office counts as critical, and the phone had no idea it existed —
    // so a record the web listed as incomplete could read "complete" here.
    joiningDate: '',
    maxDailyWorkload: 3,
    maxWeeklyWorkload: 15,
    employmentType: 'INTERNAL',
    performanceRating: 0,
    averageRating: 0,
    totalAssignments: 0,
    completedAssignments: 0,
    onTimeCompletions: 0,
    assayerCode: seed.assayerCode || '',
  };
}

export interface AssayerProfile {
  profile: ProfileDataState;
  saving: boolean;
  /**
   * Whether `profile` differs from what the server last confirmed (either from `load()` or the
   * last successful `save()`). Drives whether the Save button appears at all — see ProfileScreen,
   * where showing it unconditionally meant it sat on screen with nothing to do on every visit,
   * and a tap on it re-sent whatever was already saved for no reason.
   */
  dirty: boolean;
  /** Days the assayer has marked unavailable, as plain YYYY-MM-DD ranges. */
  leaves: LeavePeriod[];
  setLeaves: (leaves: LeavePeriod[]) => void;
  load: () => Promise<void>;
  updateField: (field: keyof ProfileDataState, value: any) => void;
  /** Resolves true when the record was actually persisted. */
  save: () => Promise<boolean>;
}

/**
 * Owns the assayer's profile: the form, the save, and the leave calendar that arrives with it.
 *
 * These sat in App.tsx as a forty-line state literal, a loader, a field setter and a save
 * routine spread across three hundred lines of unrelated code, with the leave calendar populated
 * as a side effect of the profile load from one of them and written by a modal from another.
 * Nothing about that arrangement was visible from either end.
 */
export function useAssayerProfile(user: {
  id?: string;
  assayerCode?: string;
} | null | undefined, location?: { latitude?: number; longitude?: number } | null): AssayerProfile {
  const feedback = useFeedback();

  const initialProfile = useMemo(() =>
    emptyProfile({
      assayerCode: user?.assayerCode,
      latitude: location?.latitude,
      longitude: location?.longitude,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [profile, setProfile] = useState<ProfileDataState>(initialProfile);
  /**
   * The last state the server actually confirmed — everything currently on screen is compared
   * against this to decide `dirty`. Deliberately its own state rather than derived from `profile`
   * some other way: it must NOT move every time `profile` does (that's the whole point), only on
   * a successful `load()` or `save()`.
   */
  const [baseline, setBaseline] = useState<ProfileDataState>(initialProfile);
  const [saving, setSaving] = useState(false);
  const [leaves, setLeaves] = useState<LeavePeriod[]>([]);

  const dirty = useMemo(() => JSON.stringify(profile) !== JSON.stringify(baseline), [profile, baseline]);

  const load = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await MobileApiService.getAssayerProfile(user.id);
      if (!res.success || !res.data) return;
      const p = res.data;

      // The server returns skills/languages/preferredRegions as arrays; every text field on
      // this screen is a plain comma-separated string (see `save`'s own `toArray` going the
      // other way).
      const joinArr = (v: any, fallback: string) => (Array.isArray(v) ? v.join(', ') : v || fallback);

      // Captured from inside the functional update below so `baseline` can be set to the exact
      // same merged object — `dirty` must read false immediately after a load, not just after
      // the next edit recomputes it.
      let merged: ProfileDataState | null = null;

      // Personal fields fall back to what is already on screen so a partial server record does
      // not wipe something the assayer has typed but not yet saved. Totals do not: they are the
      // server's to state, and keeping a stale number would misreport what they are owed.
      setProfile((prev) => {
        merged = {
        ...prev,
        phone: p.phone || prev.phone,
        alternatePhone: p.alternatePhone || prev.alternatePhone,
        address: p.address || prev.address,
        city: p.city || prev.city,
        state: p.state || prev.state,
        district: p.district || prev.district,
        email: p.email ?? prev.email,
        pincode: p.pincode || prev.pincode,
        skills: joinArr(p.skills, prev.skills),
        languages: joinArr(p.languages, prev.languages),
        experienceYears: p.experienceYears ?? prev.experienceYears,
        licenseNo: p.licenseNo || prev.licenseNo,
        panNumber: p.panNumber || prev.panNumber,
        bankAccountNumber: p.bankAccountNumber || prev.bankAccountNumber,
        ifscCode: p.ifscCode || prev.ifscCode,
        joiningDate: p.joiningDate || prev.joiningDate,
        assayerCode: p.assayerCode || prev.assayerCode,
        completedAssignments: p.completedAssignments ?? 0,
        totalAssignments: p.totalAssignments ?? 0,
        onTimeCompletions: p.onTimeCompletions ?? prev.onTimeCompletions,
        averageRating: p.averageRating ?? prev.averageRating,
        performanceRating: p.performanceRating ?? prev.performanceRating,
        employmentType: p.employmentType || prev.employmentType,
        maxDailyWorkload: p.maxDailyWorkload ?? prev.maxDailyWorkload,
        maxWeeklyWorkload: p.maxWeeklyWorkload ?? prev.maxWeeklyWorkload,
        /**
         * The three fields the user reported: saved fine (see `save`'s own history — the save
         * path used to 404 and was fixed), but never read back. This merge previously listed
         * only phone/address/etc — nothing here restored `emergencyName` from the server's
         * `emergencyContactName` (names differ between the two sides, same class of mismatch
         * `save` already had to fix once), or latitude/longitude/preferredRegions at all. So a
         * save would show "Profile saved" and update the fields on screen for the rest of that
         * session — then the NEXT load (app reopen, tab revisit, pull-to-refresh) reset every
         * one of these back to `emptyProfile()`'s blank defaults, because nothing here told it
         * what the server actually had. The save was never lost; the read of it was.
         */
        emergencyName: p.emergencyContactName || prev.emergencyName,
        emergencyPhone: p.emergencyContactPhone || prev.emergencyPhone,
        emergencyRelation: p.emergencyContactRelation || prev.emergencyRelation,
        latitude: p.latitude ?? prev.latitude,
        longitude: p.longitude ?? prev.longitude,
        preferredRegions: joinArr(p.preferredRegions, prev.preferredRegions),
        // Server-computed each load — an unreliable map position the assayer is asked to fix.
        locationNeedsConfirmation: !!p.locationNeedsConfirmation,
        };
        return merged;
      });
      if (merged) setBaseline(merged);

      // Normalise the leave calendar to plain YYYY-MM-DD ranges for the availability picker.
      setLeaves(
        Array.isArray(p.leaves)
          ? p.leaves
              .filter((l: any) => l?.startDate && l?.endDate)
              .map((l: any) => ({
                startDate: String(l.startDate).slice(0, 10),
                endDate: String(l.endDate).slice(0, 10),
              }))
          : [],
      );
    } catch (e) {
      console.error('Error fetching assayer profile:', e);
    }
  }, [user?.id]);

  const updateField = useCallback((field: keyof ProfileDataState, value: any) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      if (!user?.id) {
        feedback.error('Not signed in', 'Sign in again before saving your profile.');
        return false;
      }
      /**
       * Send only what actually changed, never the whole profile.
       *
       * Every save used to re-send every field, including the entire address, and the server
       * validates address consistency on each update (`assertAddressConsistent`). For the ~1,155
       * roster-imported records whose pincode and state disagree, that meant editing a PHONE
       * NUMBER was rejected with "Pincode 411045 is in Maharashtra, but the entered state is …"
       * — an error about a field the assayer had never touched, on a screen where they could not
       * see it. The record was un-editable until someone fixed an address they were not being
       * asked about.
       *
       * Diffing against the baseline also removes a whole class of silent damage: a value the
       * server holds and this screen never loaded (or loaded stale) can no longer be written back
       * over the top. If the assayer did not change it, it is not in the request at all.
       */
      const changed = changedFields(profile, baseline);
      if (Object.keys(changed).length === 0) {
        feedback.success('No changes to save');
        return true;
      }
      // `updateAssayerProfile` reports failure by return value, not by throwing, so a catch alone
      // never saw a rejected save. This claimed "Profile saved successfully" on a 404 — and the
      // endpoint it called did not exist, so that is what every save did.
      const result = await MobileApiService.updateAssayerProfile(user.id, changed);
      if (!result.success) {
        feedback.error('Not saved', result.error || 'Your profile could not be saved. Please try again.');
        return false;
      }
      // What was just sent is now what the server has, so it's the new baseline — the Save
      // button (gated on `dirty`) should disappear again until the next actual edit.
      setBaseline(profile);
      feedback.success('Profile saved');
      return true;
    } catch (e: any) {
      feedback.error('Not saved', e?.message || 'Your profile could not be saved.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [user?.id, profile, baseline, feedback]);

  return { profile, saving, dirty, leaves, setLeaves, load, updateField, save };
}
