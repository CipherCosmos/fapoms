import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SafeAreaView, ScrollView, View, ActivityIndicator, Alert, StatusBar, RefreshControl, Text, BackHandler, AppState, KeyboardAvoidingView, Platform, PanResponder } from 'react-native';
import * as haptics from './src/lib/haptics';
import { AssayerAssignment, AppNotification, AssayerExpense, ExpenseSummary, AssayerStatement } from './src/types/mobile-app';
import { MobileApiService, initApiBaseUrl } from './src/services/api.service';
import { uploadScannedAuditPacket } from './src/services/audit-packet-upload';
import { useOverlay } from './src/hooks/useOverlay';
import { loadPreferences } from './src/services/preferences';
import { initI18nFromPreferences, useT, t as translate, serverErrorText } from './src/i18n';
import { useAssayerNotifications, type NotificationTapData } from './src/hooks/useAssayerNotifications';
import { useAssayerProfile } from './src/hooks/useAssayerProfile';
import { useReturnPaperwork } from './src/hooks/useReturnPaperwork';
import { useUploadOutbox } from './src/hooks/useUploadOutbox';
import { useRegistrationChecklist } from './src/hooks/useRegistrationChecklist';
import { buildChecklistRows, checklistProgress } from './src/services/registration-checklist';
import { connectMobileSocket } from './src/services/socket';
import { registerAndroidNotificationChannels } from './src/services/notification.service';
import { handleIncomingCall, handleCallAnswered, handleCallEnded } from './src/services/calls';
import { countOpenQueries, countResolvedQueries } from './src/utils/queries';
import { parseRupeeInput, formatRupees } from '@fapoms/shared';

// Context Providers
import { ThemeProvider, ThemeContext, useTheme } from './src/theme/ThemeProvider';
import { palettes } from './src/theme/tokens';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { LocationProvider, useLocation } from './src/context/LocationContext';
import { AssignmentProvider, useAssignments } from './src/context/AssignmentContext';

// UI Shell
import { TopBar, TabDock, TabType, DOCK_CLEARANCE } from './src/components/ui/AppShell';
import { AmbientGlow, AppText, Button, Icon, Tappable } from './src/components/ui/primitives';
import { BrandLoadingScreen } from './src/components/ui/BrandMark';
import { FeedbackProvider, useFeedback } from './src/components/ui/Feedback';

// Screens
import { LoginScreen } from './src/screens/LoginScreen';
import { ChangePasswordScreen } from './src/screens/ChangePasswordScreen';
import { LockScreen } from './src/screens/LockScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { PdfDocsScreen } from './src/screens/PdfDocsScreen';
import { QueriesScreen } from './src/screens/QueriesScreen';
import { EarningsScreen } from './src/screens/EarningsScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';

// Modals
import { NotificationsModal } from './src/components/NotificationsModal';
import { DocumentScanner } from './src/components/DocumentScanner';
import { AssayerQueryChatModal } from './src/components/AssayerQueryChatModal';
import { UploadsModal } from './src/components/UploadsModal';
import { RegistrationChecklistModal } from './src/components/RegistrationChecklistModal';
import { InAppNavigationModal } from './src/components/InAppNavigationModal';
import { CallModal } from './src/components/CallModal';
import { RejectionModal } from './src/components/RejectionModal';
import { ExpenseModal, CAT_LABEL_KEYS } from './src/components/ExpenseModal';
import { NegotiateModal } from './src/components/NegotiateModal';
import { ReportIssueModal } from './src/components/ReportIssueModal';
import { FeedbackModal } from './src/components/FeedbackModal';
import { AvailabilityModal } from './src/components/AvailabilityModal';

function AppMain() {
  const theme = useTheme();
  const tr = useT();
  const { isAuthenticated, user, assayerName, authenticating, login, biometricLogin, verifyIdentity, logout, clearMustChangePassword, locked, unlock, skipUnlock } = useAuth();
  const { location, refreshLocation } = useLocation();
  const { assignments, loadAssignments, updateAssignmentStatus, rejectAssignment, submitExpense, stale, lastSyncedAt } = useAssignments();

  const [selectedTab, setSelectedTab] = useState<TabType>('HOME');
  const [refreshing, setRefreshing] = useState(false);
  // The id of the assignment whose accept/check-in is in flight, so its button shows a spinner
  // and a second tap can't fire a duplicate accept or a duplicate on-site check-in.
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const feedback = useFeedback();
  /**
   * Claim totals, read back from the server.
   *
   * The app could file an expense but never see one again — `/expenses/mine/summary` existed
   * from the start and nothing called it, so an assayer had no way to tell an approved claim
   * from a rejected one.
   */
  const [claims, setClaims] = useState<AssayerExpense[]>([]);
  const [statement, setStatement] = useState<AssayerStatement | null>(null);
  /** True when the last statement read failed. The screen says so rather than showing a figure. */
  const [statementError, setStatementError] = useState(false);
  const [expenseSummary, setExpenseSummary] = useState<ExpenseSummary>({
    pending: 0,
    approved: 0,
    rejected: 0,
    totalClaimed: 0,
  });

  // Which overlay is open and what it is open on — one value for all ten of them. See
  // `useOverlay` for why this replaced fourteen separate flags and subjects.
  const overlay = useOverlay();

  /**
   * The durable upload outbox. Packets are handed to it and sent in the background — the transfer
   * survives leaving the paperwork screen, backgrounding the app, or a dropped signal, and a
   * failed one stays visible to retry. `onUploaded` refreshes once a packet is durably accepted,
   * because filing the return moves the assignment on server-side. Read through a ref so it can
   * call `refreshAfterServerChange`, which is defined below, without a load-order hazard.
   */
  const onUploadedRef = useRef<() => void>(() => {});
  const outbox = useUploadOutbox({ onUploaded: useCallback(() => onUploadedRef.current(), []) });

  /**
   * The audited return. Not an overlay: it replaces the tab body, and the overlays above can
   * open on top of it. Filing hands the packet to the outbox rather than uploading inline.
   */
  const paperwork = useReturnPaperwork({ onEnqueue: outbox.enqueue });

  /**
   * The assayer's own registration paperwork.
   *
   * An optional accelerator, never a gate: HR completes registrations from the desk for people
   * with no smartphone, so everything here is allowed to be absent. If the checklist will not
   * load, `checklist` stays null, the banner does not appear, and the rest of the app is
   * unaffected. Registration scans share the audit packet's outbox because they share its
   * problem — a photograph taken where there is no signal, which has to send itself later.
   */
  const registration = useRegistrationChecklist(isAuthenticated);
  const registrationProgress = checklistProgress(
    buildChecklistRows(registration.checklist?.items ?? [], outbox.uploads),
  );

  const captureRegistrationDocument = useCallback(
    async (requirement: string, documentLabel: string, fileName: string, fileUri: string) => {
      await outbox.enqueue({
        target: { kind: 'REGISTRATION_DOCUMENT', assayerId: user?.id ?? '', requirement, documentLabel },
        fileName,
        fileUri,
      });
    },
    [outbox, user?.id],
  );

  // A tapped notification's target, held until `assignments` has actually loaded — a cold
  // start races the deep link against the assignment list fetch, so the target is queued
  // here and resolved by the effect below once real data exists to resolve it against.
  const [pendingNotificationTarget, setPendingNotificationTarget] = useState<{
    assignmentId?: string;
    category?: string;
  } | null>(null);

  // Transient async state for the decline, which the overlay itself does not own: it outlives a
  // single render pass and must survive the overlay being read, not written.
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  /**
   * A tapped notification's `data` payload, whatever state the app was in when it was tapped
   * (foreground banner, background, or the app launching fresh from a terminated state — all
   * three carry the same shape, from `NotificationDeliveryWorker`'s FCM `data` field).
   *
   * The tab/modal shell here has no per-notification route to push onto, so "deep link" means
   * the best a fixed shell can do: pick the tab that actually shows what the notification is
   * about, and additionally open the query chat directly when the notification was specifically
   * about a raised clarification — since that is the one case where "just look at your
   * schedule" would leave the person hunting for the actual question.
   *
   * The catalog states each type's destination as a web route in `link`; the tab is derived
   * from it rather than defaulting everything to Schedule. That default meant a "Payment sent"
   * notification opened the schedule — the one screen that says nothing about money.
   */
  const handleNotificationTap = useCallback((data: NotificationTapData) => {
    if (!data) return;
    if (data.notificationId) {
      MobileApiService.markNotificationRead(data.notificationId).catch(() => {});
    }
    const link: string = typeof data.link === 'string' ? data.link : '';

    // Money lives on its own tab and carries no assignment to select, so it returns early —
    // requiring an assignmentId below would drop these taps entirely.
    if (link.startsWith('/earnings')) {
      paperwork.close();
      setSelectedTab('EARNINGS');
      return;
    }

    const assignmentId: string | undefined =
      data.entityId || (link ? link.replace('/assignments/', '') : undefined);
    if (!assignmentId) return;
    // Dismiss any open detail view too, or the tab change lands behind it and the tapped
    // notification appears to do nothing.
    paperwork.close();
    setSelectedTab('SCHEDULE');
    setPendingNotificationTarget({ assignmentId, category: data.category });
  }, []);

  /**
   * Delivery lives in the hook; where a tap lands is decided here, because it depends on the tab
   * shell and on which assignments have loaded.
   */
  const {
    notifications,
    unreadCount: unreadNotifCount,
    load: loadNotifications,
    markRead: markNotificationRead,
    markUnread: markNotificationUnread,
    markAllRead: markAllNotificationsRead,
  } = useAssayerNotifications({ isAuthenticated, onTap: handleNotificationTap });

  // Profile data state
  /**
   * The assayer's own record — details, pay totals and the leave calendar that arrives with it.
   */
  const {
    profile,
    saving: savingProfile,
    dirty: profileDirty,
    leaves: availabilityLeaves,
    setLeaves: setAvailabilityLeaves,
    load: loadAssayerProfile,
    updateField: handleUpdateProfileField,
    save: handleSaveProfile,
  } = useAssayerProfile(user, location);

  /**
   * Refresh the earnings screen — keeping whatever it last knew for anything that fails.
   *
   * These readers used to return empties on a timeout, and this wrote them straight into state:
   * one slow request on a 2G link and Earnings showed ₹0 claimed and no statement, for a network
   * problem. Each read now throws when the server did not answer, and only the reads that
   * succeeded update their slice; a failed one leaves the previous value on screen. On a first
   * load with nothing previous the screen simply stays empty, which is honest.
   */
  const loadExpenseSummary = useCallback(async () => {
    if (!user?.id) return;
    const [summary, mine, stmt] = await Promise.allSettled([
      MobileApiService.getMyExpenseSummary(),
      MobileApiService.getMyExpenses(),
      MobileApiService.getAssayerStatement(user.id),
    ]);
    if (summary.status === 'fulfilled') setExpenseSummary(summary.value);
    if (mine.status === 'fulfilled') setClaims(mine.value);
    if (stmt.status === 'fulfilled') { setStatement(stmt.value); setStatementError(false); }
    else setStatementError(true);
  }, [user?.id]);

  /**
   * Re-reads everything a server-side mutation can move.
   *
   * Uploading an audited return completes the assignment, may create a payable, and can clear
   * a query — three different screens go stale at once. Pulling them together keeps Home,
   * Schedule and Earnings from disagreeing about what has already been filed.
   */
  const refreshAfterServerChange = useCallback(async () => {
    await Promise.all([loadAssignments(), loadAssayerProfile(), loadExpenseSummary()]);
  }, [loadAssignments, loadAssayerProfile, loadExpenseSummary]);

  // Keep the outbox's "a packet arrived" callback pointed at the current refresh. Assigned in
  // render (like selectedTabRef below) so the stable callback handed to the hook always calls the
  // latest closure.
  onUploadedRef.current = refreshAfterServerChange;


  useEffect(() => {
    if (isAuthenticated) {
      // Push registration and the opening notification load belong to useAssayerNotifications.
      loadAssayerProfile();
      loadExpenseSummary();

      const socket = connectMobileSocket();

      /**
       * The unread count, live.
       *
       * The bell badge only moved when something else happened to call `loadNotifications` —
       * a 30-second poll, or opening the panel. The backend has always emitted
       * `notification:new` straight to this assayer's own room; nothing subscribed to it.
       */
      const onNotification = () => loadNotifications();

      /** A validated payable changes the balance on Home and Earnings, not the schedule. */
      const onBilling = () => {
        loadAssayerProfile();
        loadExpenseSummary();
      };

      socket?.on('notification:new', onNotification);
      socket?.on('billing:created', onBilling);
      socket?.on('expense:decided', onBilling);

      /**
       * Voice-call signalling. The calls service owns all call state; these three events are
       * simply forwarded to it. In Expo Go (no WebRTC module) the service ignores incoming
       * rings rather than offering a call it cannot answer.
       */
      socket?.on('call:incoming', handleIncomingCall);
      socket?.on('call:answered', handleCallAnswered);
      socket?.on('call:ended', handleCallEnded);

      /**
       * A safety net, not the delivery mechanism.
       *
       * This polled every 30 seconds — two requests per handset per half-minute, running
       * whether or not anything had changed and whether or not the app was even on screen.
       * Across a full field roster that is a constant load floor that grows with headcount,
       * and it was the only thing making most updates appear at all.
       *
       * With the socket subscriptions above carrying the real changes, this exists solely to
       * recover from a missed event, so it can be far slower — and it skips entirely while the
       * app is backgrounded, where a refresh benefits nobody and costs the assayer battery
       * and mobile data.
       */
      const timer = setInterval(() => {
        if (AppState.currentState !== 'active') return;
        loadAssignments();
        loadNotifications();
      }, 5 * 60 * 1000);

      return () => {
        clearInterval(timer);
        socket?.off('notification:new', onNotification);
        socket?.off('billing:created', onBilling);
        socket?.off('expense:decided', onBilling);
        socket?.off('call:incoming', handleIncomingCall);
        socket?.off('call:answered', handleCallAnswered);
        socket?.off('call:ended', handleCallEnded);
      };
    }
  }, [isAuthenticated, loadNotifications, loadAssayerProfile, loadAssignments, loadExpenseSummary]);

  // Resolves a queued deep-link target once the assignment it points to has actually loaded —
  // opening the query chat is only meaningful once the app already knows about the query.
  useEffect(() => {
    if (!pendingNotificationTarget) return;
    const target = assignments.find((a) => a.id === pendingNotificationTarget.assignmentId);
    if (!target) return;

    if (pendingNotificationTarget.category === 'VALIDATION' && target.queries?.length) {
      overlay.open({ name: 'queryChat', assignment: target });
    }
    setPendingNotificationTarget(null);
  }, [pendingNotificationTarget, assignments, overlay.open]);

  /**
   * The next page of settled work older than the live list's window.
   *
   * The cursor lives here rather than in the screen so switching tabs does not restart paging,
   * and it is opaque — a position in the server's ordering, not something to reconstruct.
   * Returning an empty array is how the screen learns it has reached the end.
   */
  const historyCursor = useRef<string | null>(null);
  const loadOlderHistory = useCallback(async () => {
    if (!user?.id) return [];
    try {
      const { items, nextCursor } = await MobileApiService.getAssayerAssignmentHistory(
        user.id,
        historyCursor.current ?? undefined,
      );
      historyCursor.current = nextCursor;
      // No cursor back means the server has nothing older; an empty page says the same thing.
      return nextCursor === null && items.length === 0 ? [] : items;
    } catch (err) {
      feedback.error(tr('assignment.historyFailedTitle'), tr('assignment.historyFailedBody'));
      return [];
    }
  }, [user?.id, feedback, tr]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      loadAssignments(),
      refreshLocation(),
      loadNotifications(),
      loadAssayerProfile(),
      loadExpenseSummary(),
    ]);
    setRefreshing(false);
  };

  const handleAcceptAssignment = async (id: string) => {
    if (busyActionId) return;
    setBusyActionId(id);
    try {
      const res = await updateAssignmentStatus(id, 'ACCEPTED');
      if (!res.success) {
        feedback.error(
          tr('assignment.acceptFailedTitle'),
          serverErrorText(res.error, 'assignment.acceptFailedBody'),
        );
      }
    } finally {
      setBusyActionId(null);
    }
  };

  const handleConfirmReject = async () => {
    const pending = overlay.current('reject');
    if (!pending || rejectSubmitting) return;

    /**
     * A decline needs a real reason, and this is where that gets enforced.
     *
     * The server already refuses an empty one — "the branch goes back into planning and the
     * next person needs to know why" — because a decline with no cause makes the desk re-offer
     * the same fee, the same date, the same distance, and get declined again. This screen used
     * to send `reason || 'Declined by assayer'`, which satisfied that check with a string
     * carrying no information, so the guard could never fire and replanning learned nothing.
     *
     * Caught here rather than at the server so the assayer keeps what they typed and gets an
     * answer immediately, instead of a round trip that returns a validation error.
     */
    const reason = (pending.reason ?? '').trim();
    if (!reason) {
      feedback.error(tr('assignment.reasonRequiredTitle'), tr('assignment.reasonRequiredBody'));
      return;
    }

    setRejectSubmitting(true);
    try {
      const res = await rejectAssignment(pending.assignmentId, reason);
      if (res.success) {
        overlay.close();
      } else {
        feedback.error(
          tr('assignment.declineFailedTitle'),
          serverErrorText(res.error, 'assignment.declineFailedBody'),
        );
      }
    } finally {
      setRejectSubmitting(false);
    }
  };

  const handleCheckIn = async (assignment: AssayerAssignment) => {
    /**
     * Check-in is the record that proves an assayer physically stood inside the branch. It is
     * evidence in a bank collateral audit.
     *
     * This previously fell back to `assignment.latitude` (the BRANCH's own coordinates — which
     * would "prove" presence without the worker ever leaving home) and then to a hardcoded
     * New Delhi point. Both produced a confident, entirely fabricated location that was
     * indistinguishable from a genuine reading.
     *
     * A check-in without a real device fix is now refused. That is a worse experience and a
     * far better record: the assayer is told exactly what to do, and nobody is ever falsely
     * placed at — or falsely absent from — a branch.
     */
    if (busyActionId) return;

    let fix = location;
    if (!fix) {
      fix = await refreshLocation();
    }

    if (!fix) {
      Alert.alert(
        tr('assignment.locationNeededCheckIn'),
        tr('assignment.locationNeededBody'),
        [
          { text: tr('common.tryAgain'), onPress: () => handleCheckIn(assignment) },
          { text: tr('common.cancel'), style: 'cancel' },
        ],
      );
      return;
    }

    setBusyActionId(assignment.id);
    try {
      const res = await MobileApiService.checkInBranch(assignment.id, fix.latitude, fix.longitude, fix.accuracy ?? undefined);
      if (res.success) {
        await loadAssignments();
        feedback.success(
          tr('assignment.checkedInTitle'),
          tr('assignment.checkedInBody', { branch: assignment.branchName }),
        );
      } else {
        feedback.error(
          tr('assignment.checkInFailedTitle'),
          serverErrorText(res.error, 'assignment.checkInFailedBody'),
        );
      }
    } catch (err) {
      // There was no catch here: a timeout became an unhandled rejection — the spinner stopped
      // and nothing was said, and if the server HAD recorded the check-in the assayer could not
      // tell. Say what happened; the assignment reload will show the true status either way.
      const transport = MobileApiService.isTransportError(err);
      feedback.error(
        tr('assignment.serverUnreachableTitle'),
        transport
          ? tr('assignment.checkInUnconfirmed')
          : serverErrorText((err as Error)?.message, 'assignment.checkInFailedBody'),
      );
      loadAssignments().catch(() => {});
    } finally {
      setBusyActionId(null);
    }
  };

  /**
   * Leaving the branch. Closes the on-site window; does NOT finish the audit.
   *
   * Confirmed first, because it is one-way: the server keeps the first departure it is given, so
   * a mis-tap at 11am cannot be undone from the phone and would leave the visit recorded as three
   * hours long. Check-in needs no such prompt — arriving twice is harmless.
   *
   * A real device fix is required for the same reason check-in requires one: this is attendance
   * evidence, and a departure recorded at a fabricated position is worse than no departure at all.
   */
  const handleCheckOut = async (assignment: AssayerAssignment) => {
    if (busyActionId) return;

    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        tr('assignment.checkOutConfirmTitle'),
        tr('assignment.checkOutConfirmBody', { branch: assignment.branchName }),
        [
          { text: tr('assignment.checkOutConfirmCancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: tr('assignment.checkOutConfirmAccept'), style: 'destructive', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });
    if (!confirmed) return;

    let fix = location;
    if (!fix) fix = await refreshLocation();
    if (!fix) {
      Alert.alert(
        tr('assignment.locationNeededCheckOut'),
        tr('assignment.locationNeededBody'),
        [
          { text: tr('common.tryAgain'), onPress: () => handleCheckOut(assignment) },
          { text: tr('common.cancel'), style: 'cancel' },
        ],
      );
      return;
    }

    setBusyActionId(assignment.id);
    try {
      const res = await MobileApiService.checkOutBranch(assignment.id, fix.latitude, fix.longitude, fix.accuracy ?? undefined);
      if (res.success) {
        await loadAssignments();
        feedback.success(
          tr('assignment.checkedOutTitle'),
          tr('assignment.checkedOutBody', { branch: assignment.branchName }),
        );
      } else {
        feedback.error(
          tr('assignment.checkOutFailedTitle'),
          serverErrorText(res.error, 'assignment.checkOutFailedBody'),
        );
      }
    } catch (err) {
      const transport = MobileApiService.isTransportError(err);
      feedback.error(
        tr('assignment.serverUnreachableTitle'),
        transport
          ? tr('assignment.checkOutUnconfirmed')
          : serverErrorText((err as Error)?.message, 'assignment.checkOutFailedBody'),
      );
      loadAssignments().catch(() => {});
    } finally {
      setBusyActionId(null);
    }
  };

  /**
   * The assignment detail view replaces the whole tab body, so it needs a way out.
   *
   * It had none: no back control was rendered, and switching tabs did not clear it either —
   * the open assignment stayed set, so the detail view kept winning over whichever tab was
   * selected. Opening any assignment left the app with no route back short of force-closing it.
   */
  /**
   * Every tab shares one ScrollView, so its offset carried over between them: scrolling to the
   * bottom of the schedule and then opening Earnings landed you halfway down a screen you had
   * never scrolled, with the top of it — the balance — off-screen.
   */
  const scrollRef = useRef<ScrollView>(null);

  /**
   * Swipe left/right anywhere in the content area to move between tabs — the same order the
   * dock renders them in, so a swipe always agrees with which direction its own icon sits.
   */
  const TAB_ORDER: TabType[] = ['HOME', 'SCHEDULE', 'QUERIES', 'EARNINGS', 'MY_PROFILE'];
  const selectedTabRef = useRef(selectedTab);
  selectedTabRef.current = selectedTab;

  const handleSelectTab = useCallback((tab: TabType) => {
    paperwork.close();
    setSelectedTab(tab);
    // Tapping the tab you are already on returns you to the top of it, which is the
    // convention everywhere else and the only way back up a long schedule without dragging.
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [selectedTab, paperwork.assignment]);

  /**
   * The swipe itself. Attached to a wrapper around the content ScrollView, not the ScrollView
   * itself. `onMoveShouldSetPanResponder` (NOT the `...Capture` variant) only claims the gesture
   * once a drag is clearly more horizontal than vertical (`|dx| > |dy| * 1.5`, past a small dead
   * zone) — and, critically, only after any nested control has had first refusal. The capture
   * variant fires top-down before a single child gets asked, which meant a screen with its own
   * sub-tabs (ScheduleScreen's Active/History `Segmented`, QueriesScreen's Open/Resolved) could
   * never win a swipe gesture over the app-level dock: this always intercepted it first, so a
   * swipe on those screens jumped between HOME/SCHEDULE/QUERIES/etc. instead of doing anything
   * useful where the finger actually was. The plain (bubble-phase) variant is asked only once
   * nothing deeper in the tree has already claimed the touch, so a screen wanting its own
   * horizontal swipe (see useSwipeSegments.ts) now gets first claim, and this only fires when
   * nothing more specific wanted the gesture. Direction is content-follows-finger: a swipe LEFT
   * (negative dx) advances to the NEXT tab, matching how a page-turn / carousel reads, mirroring
   * `TabDock`'s left-to-right order rather than being reversed from it.
   *
   * Disabled while paperwork is open (`openPaperwork`, defined below where the content decides
   * what to render) — that view is a drill-in, not one of the five tabs, and a stray swipe while
   * filling in an audit form should not silently navigate away from it.
   */
  const tabSwipeEnabledRef = useRef(true);
  const tabSwipeResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        tabSwipeEnabledRef.current &&
        Math.abs(gesture.dx) > 24 &&
        Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderRelease: (_, gesture) => {
        if (!tabSwipeEnabledRef.current) return;
        const order = TAB_ORDER;
        const i = order.indexOf(selectedTabRef.current);
        if (i === -1) return;
        const next = gesture.dx < 0 ? order[i + 1] : order[i - 1];
        if (!next) return; // Already at the first/last tab — nothing to swipe past.
        haptics.select();
        handleSelectTab(next);
      },
    })
  ).current;

  /**
   * Android hardware/gesture back, resolved in one place.
   *
   * Back is the motion a user makes before looking for a control, and it previously only did
   * something inside the assignment detail view. From any tab other than Home it fell through
   * to the OS and closed the app — so an assayer glancing at Earnings and swiping back lost
   * the screen entirely and had to cold-start to get back to work.
   *
   * The order below is the reverse of how the screen was reached: detail first, then back to
   * Home, and only from Home does it leave the app.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (paperwork.assignment) {
        paperwork.close();
        return true;
      }
      if (selectedTab !== 'HOME') {
        setSelectedTab('HOME');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [paperwork.assignment, paperwork.close, selectedTab]);

  /*
   * `authenticating` should now only ever be true for the time it takes to read the OS
   * keystore — AuthContext's boot check no longer waits on the network (see its own comment).
   * A bare spinner on a blank background read as the app being stuck even when it wasn't; the
   * brand mark makes the same brief moment look intentional, and gives it something to sit on
   * if a very slow device or a Metro bundle load makes it last longer than usual.
   */
  if (authenticating) {
    return <BrandLoadingScreen />;
  }

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
        <LoginScreen
          onLogin={async (u, p) => {
            // An empty form is an empty form. This used to substitute a real assayer's
            // credentials, so submitting a blank login signed you in as someone else.
            const finalU = (u || '').trim();
            const finalP = (p || '').trim();
            if (!finalU || !finalP) {
              return false;
            }
            return await login(finalU, finalP);
          }}
          onVerifyIdentity={verifyIdentity}
          onBiometricLogin={async () => {
            return await biometricLogin();
          }}
        />
      </SafeAreaView>
    );
  }

  /**
   * A restored session stays behind the biometric gate until it is unlocked.
   *
   * Placed after the authentication check and before everything else so no assignment data
   * mounts underneath it — the schedule carries branch addresses and gold-packet detail.
   */
  if (locked) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
        <LockScreen name={assayerName} onUnlock={unlock} onSignOut={logout} onSkip={skipUnlock} />
      </SafeAreaView>
    );
  }

  /**
   * An account still holding an issued password sees only the change-password screen.
   *
   * Placed after the authentication gate because changing a password requires a session, and
   * before every other screen because audit work must not be done under a credential that
   * two dozen people share.
   */
  if (user?.mustChangePassword) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
        <ChangePasswordScreen onChanged={clearMustChangePassword} onLogout={logout} />
      </SafeAreaView>
    );
  }

  // Same helper Home uses, so the badge and the row beneath it can never disagree.
  const queryCount = countOpenQueries(assignments);

  /**
   * There is deliberately no earnings figure computed here.
   *
   * This screen used to sum `agreedFee + travelAllowance` across whatever assignments happened
   * to be loaded, and EarningsScreen fell back to that (and to a profile snapshot) whenever the
   * statement request failed. A number the phone works out for itself is a second answer to
   * "what am I owed" that can disagree with what finance will actually pay. The statement is the
   * only answer; when it cannot be loaded the screen says so instead of showing a figure.
   */

  // Narrowed once here rather than re-tested inside the JSX, so each modal below reads as
  // "render this when it is the open one" and gets its subject already proven to exist.
  // Bound once so the detail branch below reads without re-asserting it: a property access
  // does not narrow the way a binding does.
  const openPaperwork = paperwork.assignment;
  tabSwipeEnabledRef.current = !openPaperwork;

  const scanner = overlay.current('scanner');
  const queryChat = overlay.current('queryChat');
  const navigate = overlay.current('navigate');
  const negotiate = overlay.current('negotiate');
  const issue = overlay.current('issue');
  const reject = overlay.current('reject');
  const expense = overlay.current('expense');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />

      {/* The same ambient neon wash as the sign-in screen, behind every tab — one violet
          bloom, one cyan — so the app's ground reads as atmosphere rather than flat black. */}
      <AmbientGlow />

      {/* Header */}
      <TopBar
        name={assayerName}
        subtitle={
          profile.assayerCode || user?.assayerCode
            ? tr('shell.codeLabel', { code: profile.assayerCode || user?.assayerCode || '' })
            : tr('shell.roleFallback')
        }
        unreadCount={unreadNotifCount}
        onNotifications={() => { loadNotifications(); overlay.open({ name: 'notifications' }); }}
        onOpenProfile={() => handleSelectTab('MY_PROFILE')}
        onOpenUploads={() => overlay.open({ name: 'uploads' })}
        activeUploads={outbox.counts.active}
        failedUploads={outbox.counts.failed}
      />

      {/* Main Content Area — keyboard-avoiding so the Profile/Work form fields below the
          fold scroll into view instead of sitting under the on-screen keyboard. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        {...tabSwipeResponder.panHandlers}
      >
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingBottom: DOCK_CLEARANCE,
          flexGrow: 1,
        }}
        alwaysBounceVertical={true}
        overScrollMode="always"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[theme.colors.primary, theme.colors.accent]}
            tintColor={theme.colors.primary}
            progressBackgroundColor={theme.colors.surface}
          />
        }
      >
        {openPaperwork ? (
          <>
          <Tappable
            onPress={paperwork.close}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space.sm,
              paddingVertical: theme.space.md,
            }}
          >
            <Icon name="arrow-back" size={20} color={theme.colors.primary} />
            <AppText variant="bodyStrong" tone="primary">
              {openPaperwork.branchName || 'Back'}
            </AppText>
          </Tappable>
          <PdfDocsScreen
            activeAssignment={openPaperwork}
            uploadedPdfName={paperwork.staged?.name ?? null}
            uploadingPdf={paperwork.uploading}
            onSelectPdfFile={paperwork.selectFile}
            onOpenScanner={() => overlay.open({ name: 'scanner', assignment: openPaperwork })}
            onSubmitCompletedPdf={() => { void paperwork.submit().then((ok) => { if (ok) paperwork.close(); }); }}
            onOpenExpenseModal={() =>
              // Claim is filed against the assignment whose paperwork is open — the one the
              // assayer is demonstrably working on.
              overlay.open({ name: 'expense', assignment: openPaperwork })
            }
            onReportIssue={() => overlay.open({ name: 'issue', assignment: openPaperwork })}
            onOpenUploads={() => overlay.open({ name: 'uploads' })}
            activeUploads={outbox.counts.active}
            failedUploads={outbox.counts.failed}
          />
          </>
        ) : (
        <>
        {selectedTab === 'HOME' && (
          <HomeScreen
            assignments={assignments}
            totalAssignments={profile.totalAssignments}
            completedAssignments={profile.completedAssignments}
            averageRating={profile.averageRating}
            statement={statement}
            statementError={statementError}
            expenseSummary={expenseSummary}
            onOpenAssignment={paperwork.open}
            onCheckIn={handleCheckIn}
            onCheckOut={handleCheckOut}
            onScan={(a) => overlay.open({ name: 'scanner', assignment: a })}
            onNavigate={(a) => overlay.open({ name: 'navigate', assignment: a })}
            onAcceptOffer={(a) => handleAcceptAssignment(a.id)}
            onDeclineOffer={(a) => overlay.open({ name: 'reject', assignmentId: a.id, reason: '' })}
            onSeeSchedule={() => setSelectedTab('SCHEDULE')}
            onSeeQueries={() => setSelectedTab('QUERIES')}
            busyActionId={busyActionId}
            stale={stale}
            lastSyncedAt={lastSyncedAt}
            assayerId={user?.id}
            locationNeedsConfirmation={profile.locationNeedsConfirmation}
            onLocationConfirmed={loadAssayerProfile}
            papersOutstanding={registrationProgress.outstanding}
            papersFailed={registrationProgress.failed}
            onOpenRegistration={() => overlay.open({ name: 'registration' })}
          />
        )}

        {selectedTab === 'SCHEDULE' && (
          <ScheduleScreen
            assignments={assignments}
            busyActionId={busyActionId}
            onAcceptAssignment={handleAcceptAssignment}
            onOpenRejectModal={(id) => overlay.open({ name: 'reject', assignmentId: id, reason: '' })}
            onCheckIn={handleCheckIn}
            onCheckOut={handleCheckOut}
            onOpenPdfDocs={paperwork.open}
            onOpenScanner={(a) => overlay.open({ name: 'scanner', assignment: a })}
            onOpenQueryChat={(a) => overlay.open({ name: 'queryChat', assignment: a })}
            onOpenMap={(a) => overlay.open({ name: 'navigate', assignment: a })}
            onCounterOffer={(a) => overlay.open({ name: 'negotiate', assignment: a })}
            onLoadOlderHistory={loadOlderHistory}
          />
        )}

        {selectedTab === 'QUERIES' && (
          <QueriesScreen
            assignments={assignments}
            onOpenQueryChat={(a) => overlay.open({ name: 'queryChat', assignment: a })}
          />
        )}

        {selectedTab === 'EARNINGS' && (
          <EarningsScreen
            assignments={assignments}
            claims={claims}
            claimSummary={expenseSummary}
            statement={statement}
            statementError={statementError}
            onOpenExpenseModal={() => {
              // From the Earnings tab there is no open job, so tie the claim to the one the
              // assayer is currently on (checked in / in progress / accepted). If there is
              // none, the modal explains it must be filed from the assignment.
              const active = assignments.find(
                (a) => a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS' || a.status === 'ACCEPTED',
              );
              overlay.open({ name: 'expense', assignment: active ?? null });
            }}
          />
        )}

        {/*
          `openQueries`/`resolvedQueries` below use the same helpers the tab badge and Home use.
          They were hand-rolled here with a `(q: any)` cast and an inverted test —
          `status !== 'RESOLVED' && !== 'CLOSED'` — which counted RESPONDED as open, so a query
          the assayer had already answered showed on Profile but not in the badge: the same data,
          two different numbers. 'CLOSED' is not a status the platform has at all
          (ValidationQueryStatus is OPEN | RESPONDED | RESOLVED), and the `any` is what let that
          go unnoticed. If RESPONDED is ever worth showing here, `countAwaitingDesk` names it
          rather than folding it into "open".
        */}
        {selectedTab === 'MY_PROFILE' && (
          <ProfileScreen
            assayerName={assayerName}
            assayerCode={user?.assayerCode || profile.assayerCode}
            profile={profile}
            statement={statement}
            savingProfile={savingProfile}
            profileDirty={profileDirty}
            openQueries={countOpenQueries(assignments)}
            resolvedQueries={countResolvedQueries(assignments)}
            onUpdateProfileField={handleUpdateProfileField}
            onSaveProfile={handleSaveProfile}
            onOpenAvailability={() => overlay.open({ name: 'availability' })}
            onOpenFeedback={() => overlay.open({ name: 'feedback' })}
            onLogout={logout}
          />
        )}
        </>
        )}
      </ScrollView>
      </KeyboardAvoidingView>

      {/* Floating Animated Navigation Dock */}
      <TabDock selected={selectedTab} onSelect={handleSelectTab} queryCount={queryCount} />

      {/* Modals */}
      <RejectionModal
        visible={Boolean(reject)}
        rejectReason={reject?.reason ?? ''}
        submitting={rejectSubmitting}
        onChangeReason={(text) =>
          overlay.update((o) => (o.name === 'reject' ? { ...o, reason: text } : o))
        }
        onConfirm={handleConfirmReject}
        onCancel={overlay.close}
      />

      {scanner && (
        <DocumentScanner
          visible
          purpose={tr('scan.purpose')}
          onClose={overlay.close}
          onSaved={async (doc) => {
            // Captured before the overlay closes — `scanner` is this render's narrowed value, so
            // the assignment cannot go null underneath the upload the way a shared
            // `activeScannerAssignment` could.
            const assignment = scanner.assignment;
            overlay.close();

            // The normal path: ML Kit assembled the pages into a single PDF. Hand it to the durable
            // outbox and let it carry the packet to the desk in the background — the assayer is free
            // to move on, and a weak-signal transfer survives them doing so. Only the image-page
            // fallback (no PDF could be built — iOS/web) still uploads inline below.
            if (doc.pdfUri) {
              await outbox.enqueue({
                target: {
                  kind: 'ASSIGNMENT_PACKET',
                  assignmentId: assignment.id,
                  branchName: assignment.branchName,
                },
                fileName: doc.fileName,
                fileUri: doc.pdfUri,
              });
              feedback.success(
                tr('scan.queuedTitle'),
                doc.pageCount === 1
                  ? tr('scan.queuedOne')
                  : tr('scan.queuedMany', { count: doc.pageCount }),
              );
              return;
            }

            feedback.info(tr('scan.uploadingTitle'), tr('scan.uploadingBody', { file: doc.fileName }));
            const outcome = await uploadScannedAuditPacket(assignment.id, doc);

            // Filing the return moves the assignment on server-side (see
            // completeAssignmentForReturn). Without this the app kept showing the job as still
            // needing a scan, and the assayer could upload the same packet twice.
            if (outcome.kind !== 'failed') await refreshAfterServerChange();

            switch (outcome.kind) {
              case 'uploaded':
                feedback.success(
                  tr('scan.uploadedTitle'),
                  outcome.pageCount === 1
                    ? tr('scan.uploadedOne', { file: outcome.fileName })
                    : tr('scan.uploadedMany', { count: outcome.pageCount, file: outcome.fileName }),
                );
                break;
              case 'failed':
                feedback.error(
                  tr('scan.failedTitle'),
                  outcome.error
                    ? tr('scan.failedBodyReason', { file: outcome.fileName, reason: outcome.error })
                    : tr('scan.failedBody', { file: outcome.fileName }),
                );
                break;
              case 'pages-uploaded':
                feedback.success(
                  tr('scan.uploadedTitle'),
                  outcome.total === 1
                    ? tr('scan.allUploadedOne')
                    : tr('scan.allUploadedMany', { count: outcome.total }),
                );
                break;
              case 'pages-partial':
                feedback.warning(
                  tr('scan.partialTitle'),
                  tr(outcome.failed.length === 1 ? 'scan.partialOne' : 'scan.partialMany', {
                    uploaded: outcome.uploaded,
                    total: outcome.total,
                    pages: outcome.failed.join(', '),
                  }),
                );
                break;
            }
          }}
        />
      )}

      {queryChat && (
        <AssayerQueryChatModal visible assignment={queryChat.assignment} onClose={overlay.close} />
      )}

      <UploadsModal
        visible={Boolean(overlay.current('uploads'))}
        uploads={outbox.uploads}
        onClose={overlay.close}
        onRetry={outbox.retry}
        onDismiss={outbox.dismiss}
      />

      {/*
        Open on demand for anybody, and unavoidable for a session that exists only to finish
        registering.

        An assayer still in one of the joining stages can sign in now, but the server answers 403
        on every route outside registration. Left to the ordinary tabs they would land on Home,
        watch every read fail, and see empty lists with no route to the one screen the session is
        for — the same dead end the forced-password gate was written to remove, arriving through a
        different door. `onClose` is a no-op in that state because there is nothing behind this to
        return to; signing out is the other way out, and the screen offers it.
      */}
      <RegistrationChecklistModal
        visible={Boolean(overlay.current('registration')) || Boolean(user?.registrationInProgress)}
        onClose={user?.registrationInProgress ? () => {} : overlay.close}
        checklist={registration.checklist}
        uploads={outbox.uploads}
        onCapture={captureRegistrationDocument}
        onRetry={outbox.retry}
        onReload={() => { void registration.reload(); }}
        assayerId={user?.id ?? ''}
        locationNeedsConfirmation={Boolean(profile.locationNeedsConfirmation)}
        onLocationConfirmed={loadAssayerProfile}
      />

      {/* Voice-call UI, mounted once at root like the navigation modal. Renders nothing
          while no call exists; the calls service's store drives it entirely. */}
      <CallModal />

      {navigate && (
        <InAppNavigationModal visible assignment={navigate.assignment} onClose={overlay.close} />
      )}

      {overlay.current('notifications') && (
        <NotificationsModal
          visible
          notifications={notifications}
          unreadCount={unreadNotifCount}
          onClose={overlay.close}
          onMarkRead={markNotificationRead}
          onMarkUnread={markNotificationUnread}
          onMarkAllRead={markAllNotificationsRead}
          onTapNotification={(n) => {
            overlay.close();
            if (n.link) handleNotificationTap({ notificationId: n.id, entityId: n.assignmentId, link: n.link });
          }}
        />
      )}

      {expense && (
        <ExpenseModal
          visible
          quotedTravelFee={expense.assignment?.quotedTravelFee}
          quotedTransportMode={expense.assignment?.quotedTransportMode}
          onClose={overlay.close}
          onAddExpense={async (category, amount, description) => {
            // Against the assignment chosen at the entry point, never assignments[0]. The old
            // code filed every claim against whatever assignment happened to sort first — so a
            // travel claim for today's branch could land on a completed job from weeks ago, and
            // with an empty list it was silently dropped with no error.
            if (!expense.assignment?.id) {
              feedback.error(tr('expense.noAssignmentTitle'), tr('expense.noAssignmentBody'));
              return;
            }
            /**
             * Parsed once, here, and refused rather than coerced.
             *
             * This was `Number(amount) || 0`, which files ₹0 for any input `Number` cannot read —
             * "1,000" among them, which the modal's own `parseFloat` check had already waved
             * through as valid. The claim was then confirmed back to the assayer as
             * "₹1,000 awaiting approval", because the toast interpolated the raw text instead of
             * the number actually sent. Money on screen must be the money that was filed.
             */
            const parsedAmount = parseRupeeInput(amount);
            if (parsedAmount === null) {
              feedback.error(tr('expense.invalidAmountTitle'), tr('expense.invalidAmountBody'));
              return;
            }
            const res = await submitExpense(expense.assignment.id, {
              category: category as any,
              amount: parsedAmount,
              description,
            });
            if (res.success) {
              feedback.success(
                tr('expense.filedTitle'),
                tr('expense.filedBody', {
                  amount: formatRupees(parsedAmount),
                  category: tr(CAT_LABEL_KEYS[category]),
                }),
              );
              overlay.close();
              // Pull the totals back so the new claim shows on Home immediately rather
              // than only after the next manual pull-to-refresh.
              loadExpenseSummary();
            } else {
              feedback.error(
                tr('expense.failedTitle'),
                serverErrorText(res.error, 'expense.failedBody'),
              );
            }
          }}
        />
      )}

      <FeedbackModal visible={Boolean(overlay.current('feedback'))} onClose={overlay.close} />

      {issue && (
        <ReportIssueModal
          visible
          assignment={issue.assignment}
          onClose={overlay.close}
          onSubmit={async (category, note) => {
            const res = await MobileApiService.reportAssignmentIssue(issue.assignment.id, category, note);
            if (res.success) {
              feedback.success(tr('issue.sentTitle'), tr('issue.sentBody'));
              return true;
            }
            feedback.error(tr('issue.failedTitle'), serverErrorText(res.error, 'issue.failedBody'));
            return false;
          }}
        />
      )}

      {overlay.current('availability') && (
        <AvailabilityModal
          visible
          initialLeaves={availabilityLeaves}
          onClose={overlay.close}
          onSave={async (leaves) => {
            if (!user?.id) return false;
            const res = await MobileApiService.updateAvailability(user.id, { leaves });
            if (res.success) {
              setAvailabilityLeaves(leaves);
              feedback.success(tr('availability.savedTitle'), tr('availability.savedBody'));
              void loadAssayerProfile();
              return true;
            }
            feedback.error(
              tr('availability.failedTitle'),
              serverErrorText(res.error, 'availability.failedBody'),
            );
            return false;
          }}
        />
      )}

      {negotiate && (
        <NegotiateModal
          visible
          // Pass the real fee (0 when unresolved), not `|| 1800`. The modal seeds an empty
          // counter-offer box for a non-positive fee on purpose; injecting 1800 here defeated
          // that guard and re-fabricated the phantom asking price it exists to prevent.
          currentFee={negotiate.assignment.proposedFee || 0}
          quotedTravelFee={negotiate.assignment.quotedTravelFee}
          counterTravelFee={negotiate.assignment.counterTravelFee}
          quotedTransportMode={negotiate.assignment.quotedTransportMode}
          quotedDistanceKm={negotiate.assignment.quotedDistanceKm}
          onCancel={overlay.close}
          onSubmit={async (counterTravelFee, remarks) => {
            const res = await updateAssignmentStatus(
              negotiate.assignment.id,
              'PENDING',
              remarks,
              { counterTravelFee }
            );
            if (res.success) {
              // Says travel, because that is what moved. The audit fee comes from the rate card
              // and is not the assayer's to change — telling them "your fee of ₹650" when 650 is
              // the travel would have them expecting a fee they never asked for.
              feedback.success(
                tr('negotiate.sentTitle'),
                tr('negotiate.sentBody', { amount: formatRupees(counterTravelFee) }),
              );
              overlay.close();
            } else {
              feedback.error(
                tr('negotiate.failedTitle'),
                serverErrorText(res.error, 'negotiate.failedBody'),
              );
            }
          }}
        />
      )}
    </SafeAreaView>
  );
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: any }
> {
  // A class component cannot call `useTheme()`, and error boundaries have no hook form. This is
  // the sanctioned way for a class to read context; the fallback used to hardcode the dark
  // palette and paint a black screen with white text over a light-mode app.
  static contextType = ThemeContext;
  // Typed at the point of use rather than with a `declare context` field: Babel's transform
  // rejects `declare` unless `allowDeclareFields` is on, so that form typechecks but fails the
  // Metro bundle — a break that `tsc` cannot see and only surfaces at publish time.

  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('Uncaught App Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      // If the theme context itself is what failed, fall back to the dark palette rather than
      // crashing the boundary — a boundary that throws takes the whole tree down with it.
      const ctx = this.context as React.ContextType<typeof ThemeContext> | undefined;
      const c = ctx?.colors ?? palettes.dark;
      const dark = (ctx?.mode ?? 'dark') === 'dark';
      return (
        <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
          <View style={{ gap: 12, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={c.primary} />
            <Text style={{ color: c.text, fontSize: 20, fontWeight: '700' }}>{translate('login.appName')}</Text>
            <Text style={{ color: c.danger, textAlign: 'center', marginVertical: 10 }}>
              {String(this.state.error?.message || this.state.error || translate('shell.crashFallback'))}
            </Text>
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}
(AppErrorBoundary.prototype as any).isReactComponent = {};

export default function App() {
  /**
   * The device's saved server address has to be applied before anything issues a request —
   * AuthProvider restores the session on mount, so rendering it first would send that call to
   * the build-time default and fail on any install pointed at a different backend. Reading a
   * small file is fast; this gate is imperceptible in practice.
   */
  const [apiReady, setApiReady] = useState(false);

  useEffect(() => {
    // Device preferences are loaded alongside the server address: both are read from disk
    // and both are consulted by code that runs synchronously afterwards (the notification
    // chime, the sign-in screen's biometric option), so neither can be awaited later.
    Promise.all([
      initApiBaseUrl().catch(() => { /* falls back to the built-in default */ }),
      loadPreferences()
        // The language is applied here, inside the gate, rather than by a provider inside the
        // tree. Every screen past this point renders in the right language on its first paint —
        // there is no English frame that flips to Hindi a moment later, which on a cheap handset
        // is long enough to read and confusing enough to make somebody tap the wrong thing.
        //
        // Android's notification channels are registered straight after, because their names and
        // descriptions are copy the assayer reads in the phone's own settings and they can only
        // be written in a language the app has already resolved.
        .then(() => { initI18nFromPreferences(); registerAndroidNotificationChannels(); })
        .catch(() => { /* falls back to defaults, and to English */ }),
    ]).finally(() => setApiReady(true));
  }, []);

  if (!apiReady) {
    // The very first frame the app ever paints. This used to be a bare `ActivityIndicator` on a
    // hardcoded hex background — a plain spinner with none of the brand identity that greets the
    // user one screen later on BrandLoadingScreen (the auth-restore wait) and LoginScreen. Reusing
    // the same orbit mark here means the cold start and the auth wait read as one continuous
    // moment instead of "generic spinner, then suddenly the real app."
    return (
      <ThemeProvider>
        <BrandLoadingScreen />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <AppErrorBoundary>
        <AuthProvider>
          <LocationProvider>
            <AssignmentProvider>
              <FeedbackProvider>
                <AppMain />
              </FeedbackProvider>
            </AssignmentProvider>
          </LocationProvider>
        </AuthProvider>
      </AppErrorBoundary>
    </ThemeProvider>
  );
}
