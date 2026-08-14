import { useCallback, useState } from 'react';
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
function emptyProfile(seed: { assayerCode?: string; latitude?: number; longitude?: number }): ProfileDataState {
  return {
    phone: '',
    alternatePhone: '',
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
    maxDailyWorkload: 3,
    maxWeeklyWorkload: 15,
    employmentType: 'INTERNAL',
    performanceRating: 0,
    averageRating: 0,
    totalAssignments: 0,
    completedAssignments: 0,
    onTimeCompletions: 0,
    totalEarnings: 0,
    runningBalance: 0,
    earningsPaid: 0,
    earningsAwaitingApproval: 0,
    assayerCode: seed.assayerCode || '',
  };
}

export interface AssayerProfile {
  profile: ProfileDataState;
  saving: boolean;
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

  const [profile, setProfile] = useState<ProfileDataState>(() =>
    emptyProfile({
      assayerCode: user?.assayerCode,
      latitude: location?.latitude,
      longitude: location?.longitude,
    }),
  );
  const [saving, setSaving] = useState(false);
  const [leaves, setLeaves] = useState<LeavePeriod[]>([]);

  const load = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await MobileApiService.getAssayerProfile(user.id);
      if (!res.success || !res.data) return;
      const p = res.data;

      // Personal fields fall back to what is already on screen so a partial server record does
      // not wipe something the assayer has typed but not yet saved. Totals do not: they are the
      // server's to state, and keeping a stale number would misreport what they are owed.
      setProfile((prev) => ({
        ...prev,
        phone: p.phone || prev.phone,
        alternatePhone: p.alternatePhone || prev.alternatePhone,
        address: p.address || prev.address,
        city: p.city || prev.city,
        state: p.state || prev.state,
        district: p.district || prev.district,
        pincode: p.pincode || prev.pincode,
        skills: p.skills || prev.skills,
        languages: p.languages || prev.languages,
        experienceYears: p.experienceYears ?? prev.experienceYears,
        licenseNo: p.licenseNo || prev.licenseNo,
        panNumber: p.panNumber || prev.panNumber,
        bankAccountNumber: p.bankAccountNumber || prev.bankAccountNumber,
        ifscCode: p.ifscCode || prev.ifscCode,
        assayerCode: p.assayerCode || prev.assayerCode,
        totalEarnings: p.totalEarnings ?? 0,
        runningBalance: p.runningBalance ?? 0,
        earningsPaid: p.earningsPaid ?? 0,
        earningsAwaitingApproval: p.earningsAwaitingApproval ?? 0,
        completedAssignments: p.completedAssignments ?? 0,
        totalAssignments: p.totalAssignments ?? 0,
        averageRating: p.averageRating ?? prev.averageRating,
      }));

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
      // `updateAssayerProfile` reports failure by return value, not by throwing, so a catch alone
      // never saw a rejected save. This claimed "Profile saved successfully" on a 404 — and the
      // endpoint it called did not exist, so that is what every save did.
      const result = await MobileApiService.updateAssayerProfile(user.id, profile);
      if (!result.success) {
        feedback.error('Not saved', result.error || 'Your profile could not be saved. Please try again.');
        return false;
      }
      feedback.success('Profile saved');
      return true;
    } catch (e: any) {
      feedback.error('Not saved', e?.message || 'Your profile could not be saved.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [user?.id, profile, feedback]);

  return { profile, saving, leaves, setLeaves, load, updateField, save };
}
