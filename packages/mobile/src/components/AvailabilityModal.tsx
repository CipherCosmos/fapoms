import React, { useMemo, useState } from 'react';
import { Modal, View, ScrollView, Pressable } from 'react-native';
import { formatDateOnly } from '@fapoms/shared';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, IconButton, Tappable } from './ui/primitives';

export interface LeavePeriod {
  startDate: string; // YYYY-MM-DD
  endDate: string;
}

export interface AvailabilityModalProps {
  visible: boolean;
  initialLeaves: LeavePeriod[];
  onClose: () => void;
  /** Persists the full leave list; resolves true on success so the caller can confirm. */
  onSave: (leaves: LeavePeriod[]) => Promise<boolean>;
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const toKey = (y: number, m: number, d: number): string =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const todayKey = (): string => {
  const n = new Date();
  return toKey(n.getFullYear(), n.getMonth(), n.getDate());
};

const prettyRange = (l: LeavePeriod): string => {
  const fmt = (s: string) => formatDateOnly(s, { day: 'numeric', month: 'short' });
  return l.startDate === l.endDate ? fmt(l.startDate) : `${fmt(l.startDate)} – ${fmt(l.endDate)}`;
};

/**
 * Assayer self-service time off.
 *
 * The scheduler already refuses to place work on a day an assayer is on leave, so this is the
 * control that actually keeps offers away while they are out. Built on a dependency-free inline
 * month calendar rather than a native date picker: it needs no prebuild, behaves identically on
 * every device, and works on the web preview too.
 *
 * A range is chosen by tapping a start day and then an end day. Past days are not selectable —
 * leave that has already begun is a back-office correction, not a field self-service action.
 */
export const AvailabilityModal: React.FC<AvailabilityModalProps> = ({
  visible,
  initialLeaves,
  onClose,
  onSave,
}) => {
  const t = useTheme();
  const [leaves, setLeaves] = useState<LeavePeriod[]>(initialLeaves);
  const [monthOffset, setMonthOffset] = useState(0);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset local state whenever the modal is re-opened with fresh server data.
  React.useEffect(() => {
    if (visible) {
      setLeaves(initialLeaves);
      setPendingStart(null);
      setMonthOffset(0);
    }
  }, [visible, initialLeaves]);

  const today = todayKey();

  const { year, month, weeks, monthLabel } = useMemo(() => {
    const base = new Date();
    base.setDate(1);
    base.setMonth(base.getMonth() + monthOffset);
    const y = base.getFullYear();
    const m = base.getMonth();
    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    const cells: (number | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    const rows: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    // Always render six week-rows. Months span 5 or 6 rows, and letting the grid change height
    // made the whole bottom sheet jump up and down when paging months — the "drift".
    while (rows.length < 6) rows.push([null, null, null, null, null, null, null]);

    return {
      year: y,
      month: m,
      weeks: rows,
      monthLabel: base.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    };
  }, [monthOffset]);

  const isInAnyLeave = (key: string): boolean =>
    leaves.some((l) => key >= l.startDate && key <= l.endDate);

  const onTapDay = (day: number) => {
    const key = toKey(year, month, day);
    if (key < today) return; // past days are not self-serviceable

    // Tapping a day already inside a saved leave removes that whole block.
    const covering = leaves.find((l) => key >= l.startDate && key <= l.endDate);
    if (covering) {
      setLeaves((prev) => prev.filter((l) => l !== covering));
      setPendingStart(null);
      return;
    }

    if (!pendingStart) {
      setPendingStart(key);
      return;
    }

    const start = pendingStart <= key ? pendingStart : key;
    const end = pendingStart <= key ? key : pendingStart;
    setLeaves((prev) => [...prev, { startDate: start, endDate: end }].sort((a, b) => a.startDate.localeCompare(b.startDate)));
    setPendingStart(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onSave(leaves);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'flex-end' }}>
        <Tappable onPress={onClose} style={{ flex: 1 }} accessibilityLabel="Dismiss">
          <View style={{ flex: 1 }} />
        </Tappable>

        <View
          style={{
            backgroundColor: t.colors.bg,
            borderTopLeftRadius: t.radius.xl,
            borderTopRightRadius: t.radius.xl,
            paddingHorizontal: t.space.xl,
            paddingTop: t.space.md,
            paddingBottom: t.space['2xl'],
            gap: t.space.lg,
            // Fixed height (not maxHeight) so the sheet edge stays put; the list scrolls inside it
            // rather than the whole sheet growing as leaves are added.
            height: '88%',
          }}
        >
          <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: t.colors.border }} />

          {/* Explicit close control. Relying on the thin backdrop strip above a 90%-tall sheet (and
              on Android hardware back) left field users with no obvious way out. */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
            <View style={{ flex: 1, gap: t.space.xs }}>
              <AppText variant="h2">Your availability</AppText>
              <AppText variant="small" tone="muted">
                Mark the days you are off. You won't be offered audits on those days.
              </AppText>
            </View>
            <IconButton icon="close" onPress={onClose} accessibilityLabel="Close" size={38} />
          </View>

          <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: t.space.sm }}>
            {/* Month header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: t.space.md }}>
              <Tappable onPress={() => setMonthOffset((v) => Math.max(0, v - 1))} disabled={monthOffset === 0} accessibilityRole="button" accessibilityLabel="Previous month">
                <View style={{ padding: t.space.sm, opacity: monthOffset === 0 ? 0.35 : 1 }}>
                  <Icon name="chevron-back" size={20} color={t.colors.text} />
                </View>
              </Tappable>
              <AppText variant="bodyStrong">{monthLabel}</AppText>
              <Tappable onPress={() => setMonthOffset((v) => v + 1)} accessibilityRole="button" accessibilityLabel="Next month">
                <View style={{ padding: t.space.sm }}>
                  <Icon name="chevron-forward" size={20} color={t.colors.text} />
                </View>
              </Tappable>
            </View>

            {/* Weekday labels */}
            <View style={{ flexDirection: 'row', marginBottom: t.space.xs }}>
              {DAY_LABELS.map((d, i) => (
                <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                  <AppText variant="caption" tone="faint">{d}</AppText>
                </View>
              ))}
            </View>

            {/* Weeks */}
            {weeks.map((week, wi) => (
              <View key={wi} style={{ flexDirection: 'row' }}>
                {week.map((day, di) => {
                  if (day == null) return <View key={di} style={{ flex: 1, height: 46 }} />;
                  const key = toKey(year, month, day);
                  const past = key < today;
                  const onLeave = isInAnyLeave(key);
                  const isPending = pendingStart === key;
                  const isToday = key === today;
                  const bg = onLeave || isPending ? t.colors.primary : 'transparent';
                  const fg = onLeave || isPending
                    ? t.colors.onPrimary
                    : past
                      ? t.colors.textFaint
                      : t.colors.text;
                  return (
                    // Pressable directly (not Tappable): Tappable leaves its Pressable
                    // unstyled and puts the passed style on an inner Animated.View, so a
                    // `flex: 1` there has no bounded parent and the cell collapses to zero
                    // height — which is exactly what hid every day number.
                    <Pressable
                      key={di}
                      onPress={() => onTapDay(day)}
                      style={{ flex: 1, height: 46, padding: 3 }}
                      accessibilityRole="button"
                      // A bare "46" tells a screen-reader user nothing about which day it is or
                      // whether it is already marked; the visible state is colour alone.
                      accessibilityLabel={`${day} ${monthLabel}${isToday ? ', today' : ''}${onLeave ? ', marked as time off' : isPending ? ', selected as start' : ''}`}
                      accessibilityState={{ selected: onLeave || isPending, disabled: past }}
                    >
                      <View
                        style={{
                          flex: 1,
                          borderRadius: t.radius.md,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: bg,
                          borderWidth: isToday && !onLeave && !isPending ? 1 : 0,
                          borderColor: t.colors.primary,
                          opacity: past ? 0.5 : 1,
                        }}
                      >
                        <AppText variant="small" style={{ color: fg }}>{day}</AppText>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ))}

            <AppText variant="caption" tone="faint" style={{ marginTop: t.space.sm }}>
              {pendingStart
                ? 'Now tap the last day of your time off.'
                : 'Tap a start day, then an end day. Tap a marked day to remove it.'}
            </AppText>

            {/* Saved leave list */}
            {leaves.length > 0 && (
              <View style={{ gap: t.space.sm, marginTop: t.space.lg }}>
                <AppText variant="overline" tone="faint">TIME OFF</AppText>
                {leaves.map((l, i) => (
                  <View
                    key={`${l.startDate}-${l.endDate}-${i}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingVertical: t.space.sm,
                      paddingHorizontal: t.space.md,
                      borderRadius: t.radius.md,
                      backgroundColor: t.colors.surface,
                      borderWidth: 1,
                      borderColor: t.colors.border,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                      <Icon name="calendar-clear-outline" size={16} color={t.colors.primary} />
                      <AppText variant="body">{prettyRange(l)}</AppText>
                    </View>
                    <Tappable onPress={() => setLeaves((prev) => prev.filter((x) => x !== l))}>
                      <Icon name="close-circle" size={20} color={t.colors.textFaint} />
                    </Tappable>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          <Button label={busy ? 'Saving…' : 'Save availability'} icon="checkmark" onPress={save} loading={busy} size="lg" full />
        </View>
      </View>
    </Modal>
  );
};
