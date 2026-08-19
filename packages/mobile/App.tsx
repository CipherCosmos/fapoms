import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SafeAreaView, ScrollView, View, ActivityIndicator, Alert, StatusBar, RefreshControl, Text, BackHandler, AppState, KeyboardAvoidingView, Platform, PanResponder } from 'react-native';
import * as haptics from './src/lib/haptics';
import { AssayerAssignment, AppNotification, AssayerExpense, ExpenseSummary, AssayerStatement } from './src/types/mobile-app';
import { MobileApiService, initApiBaseUrl } from './src/services/api.service';
import { uploadScannedAuditPacket } from './src/services/audit-packet-upload';
import { useOverlay } from './src/hooks/useOverlay';
import { loadPreferences } from './src/services/preferences';
import { useAssayerNotifications, type NotificationTapData } from './src/hooks/useAssayerNotifications';
import { useAssayerProfile } from './src/hooks/useAssayerProfile';
import { useReturnPaperwork } from './src/hooks/useReturnPaperwork';
import { connectMobileSocket } from './src/services/socket';
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
import { InAppNavigationModal } from './src/components/InAppNavigationModal';
import { CallModal } from './src/components/CallModal';
import { RejectionModal } from './src/components/RejectionModal';
import { ExpenseModal } from './src/components/ExpenseModal';
import { NegotiateModal } from './src/components/NegotiateModal';
import { ReportIssueModal } from './src/components/ReportIssueModal';
import { FeedbackModal } from './src/components/FeedbackModal';
import { AvailabilityModal } from './src/components/AvailabilityModal';

function AppMain() {
  const theme = useTheme();
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
   * The audited return. Not an overlay: it replaces the tab body, and the overlays above can
   * open on top of it.
   */
  const paperwork = useReturnPaperwork({ onSubmitted: () => refreshAfterServerChange() });

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
      feedback.error('Could not load older jobs', 'The connection dropped. Try again in a moment.');
      return [];
    }
  }, [user?.id, feedback]);

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
        feedback.error('Not accepted', res.error || 'The assignment could not be accepted.');
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
      feedback.error(
        'Add a reason',
        'Tell the desk why you are declining — too far, fee too low, date impossible. They need it to re-plan the branch.',
      );
      return;
    }

    setRejectSubmitting(true);
    try {
      const res = await rejectAssignment(pending.assignmentId, reason);
      if (res.success) {
        overlay.close();
      } else {
        feedback.error('Not declined', res.error || 'The assignment could not be declined.');
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
        'Location needed to check in',
        'We could not get your location. Turn on location for this app, step outside if you are indoors, then try again.',
        [{ text: 'Try again', onPress: () => handleCheckIn(assignment) }, { text: 'Cancel', style: 'cancel' }],
      );
      return;
    }

    setBusyActionId(assignment.id);
    try {
      const res = await MobileApiService.checkInBranch(assignment.id, fix.latitude, fix.longitude, fix.accuracy ?? undefined);
      if (res.success) {
        await loadAssignments();
        feedback.success('Checked In', `Checked in at ${assignment.branchName}`);
      } else {
        feedback.error('Could not check in', res.error || 'Check-in failed. Please try again.');
      }
    } catch (err) {
      // There was no catch here: a timeout became an unhandled rejection — the spinner stopped
      // and nothing was said, and if the server HAD recorded the check-in the assayer could not
      // tell. Say what happened; the assignment reload will show the true status either way.
      const transport = MobileApiService.isTransportError(err);
      feedback.error(
        'Could not reach the server',
        transport
          ? 'Your check-in was not confirmed — the connection dropped. Move to better signal and tap Check in again; if it already went through, it will show as checked in.'
          : (err as Error)?.message || 'Check-in failed. Please try again.',
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
        subtitle={profile.assayerCode ? `Code: ${profile.assayerCode}` : (user?.assayerCode ? `Code: ${user.assayerCode}` : 'Field Assayer')}
        unreadCount={unreadNotifCount}
        onNotifications={() => { loadNotifications(); overlay.open({ name: 'notifications' }); }}
        onOpenProfile={() => handleSelectTab('MY_PROFILE')}
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
            onScan={(a) => overlay.open({ name: 'scanner', assignment: a })}
            onNavigate={(a) => overlay.open({ name: 'navigate', assignment: a })}
            onAcceptOffer={(a) => handleAcceptAssignment(a.id)}
            onDeclineOffer={(a) => overlay.open({ name: 'reject', assignmentId: a.id, reason: '' })}
            onSeeSchedule={() => setSelectedTab('SCHEDULE')}
            onSeeQueries={() => setSelectedTab('QUERIES')}
            busyActionId={busyActionId}
            stale={stale}
            lastSyncedAt={lastSyncedAt}
          />
        )}

        {selectedTab === 'SCHEDULE' && (
          <ScheduleScreen
            assignments={assignments}
            busyActionId={busyActionId}
            onAcceptAssignment={handleAcceptAssignment}
            onOpenRejectModal={(id) => overlay.open({ name: 'reject', assignmentId: id, reason: '' })}
            onCheckIn={handleCheckIn}
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
          purpose="Audited return for this assignment"
          onClose={overlay.close}
          onSaved={async (doc) => {
            // Captured before the overlay closes — `scanner` is this render's narrowed value, so
            // the assignment cannot go null underneath the upload the way a shared
            // `activeScannerAssignment` could.
            const assignment = scanner.assignment;
            overlay.close();

            feedback.info('Uploading', `Sending ${doc.fileName}…`);
            const outcome = await uploadScannedAuditPacket(assignment.id, doc);

            // Filing the return moves the assignment on server-side (see
            // completeAssignmentForReturn). Without this the app kept showing the job as still
            // needing a scan, and the assayer could upload the same packet twice.
            if (outcome.kind !== 'failed') await refreshAfterServerChange();

            switch (outcome.kind) {
              case 'uploaded':
                feedback.success(
                  'Upload complete',
                  `${outcome.pageCount} page${outcome.pageCount === 1 ? '' : 's'} uploaded as ${outcome.fileName}.`,
                );
                break;
              case 'failed':
                feedback.error(
                  'Upload failed',
                  `${outcome.fileName} was not uploaded${outcome.error ? `: ${outcome.error}` : ''}. Please retry before leaving the branch.`,
                );
                break;
              case 'pages-uploaded':
                feedback.success(
                  'Upload complete',
                  `All ${outcome.total} page${outcome.total === 1 ? '' : 's'} were uploaded.`,
                );
                break;
              case 'pages-partial':
                feedback.warning(
                  'Some pages did not upload',
                  `${outcome.uploaded} of ${outcome.total} uploaded. Page${outcome.failed.length === 1 ? '' : 's'} ${outcome.failed.join(', ')} failed — please scan ${outcome.failed.length === 1 ? 'it' : 'them'} again before leaving the branch.`,
                );
                break;
            }
          }}
        />
      )}

      {queryChat && (
        <AssayerQueryChatModal visible assignment={queryChat.assignment} onClose={overlay.close} />
      )}

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
              feedback.error(
                'No assignment selected',
                'Open the assignment you are claiming for and file the expense from there.',
              );
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
              feedback.error(
                'Enter a valid amount',
                'Use digits only, for example 1000 or 1,000.',
              );
              return;
            }
            const res = await submitExpense(expense.assignment.id, {
              category: category as any,
              amount: parsedAmount,
              description,
            });
            if (res.success) {
              feedback.success('Claim filed', `${formatRupees(parsedAmount)} for ${category} is awaiting approval.`);
              overlay.close();
              // Pull the totals back so the new claim shows on Home immediately rather
              // than only after the next manual pull-to-refresh.
              loadExpenseSummary();
            } else {
              feedback.error('Claim not filed', res.error || 'The expense could not be submitted.');
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
              feedback.success('Reported to desk', 'The operations team has been notified and will follow up.');
              return true;
            }
            feedback.error('Not sent', res.error || 'The issue could not be reported. Please try again.');
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
              feedback.success('Availability saved', 'You won\u2019t be offered audits on your days off.');
              void loadAssayerProfile();
              return true;
            }
            feedback.error('Not saved', res.error || 'Your availability could not be saved.');
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
          quotedTransportMode={negotiate.assignment.quotedTransportMode}
          quotedDistanceKm={negotiate.assignment.quotedDistanceKm}
          onCancel={overlay.close}
          onSubmit={async (counterFee, remarks) => {
            const res = await updateAssignmentStatus(
              negotiate.assignment.id,
              'PENDING',
              remarks,
              { proposedFee: counterFee }
            );
            if (res.success) {
              feedback.success(
                'Counter-Offer Submitted',
                `Your proposed fee of ${formatRupees(counterFee)} has been sent to Operations.`
              );
              overlay.close();
            } else {
              feedback.error('Offer not sent', res.error || 'The counter-offer could not be submitted.');
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
            <Text style={{ color: c.text, fontSize: 20, fontWeight: '700' }}>Orbit</Text>
            <Text style={{ color: c.danger, textAlign: 'center', marginVertical: 10 }}>
              {String(this.state.error?.message || this.state.error || 'App encountered an error')}
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
      loadPreferences().catch(() => { /* falls back to defaults */ }),
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
