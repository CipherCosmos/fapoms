import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SafeAreaView, ScrollView, View, ActivityIndicator, Alert, StatusBar, RefreshControl, Text, BackHandler, AppState, KeyboardAvoidingView, Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { AssayerAssignment, AppNotification, AssayerExpense, ExpenseSummary, AssayerStatement } from './src/types/mobile-app';
import { MobileApiService, initApiBaseUrl } from './src/services/api.service';
import { loadPreferences } from './src/services/preferences';
import {
  registerForPushNotificationsAsync,
  setupNotificationListeners,
  getLastNotificationResponseAsync,
  triggerAlertNotification,
} from './src/services/notification.service';
import { getAssignmentTotalFee } from './src/utils/fees';
import { connectMobileSocket } from './src/services/socket';
import { handleIncomingCall, handleCallAnswered, handleCallEnded } from './src/services/calls';
import { countOpenQueries } from './src/utils/queries';
import { assetToBase64 } from './src/utils/pickDocument';

// Context Providers
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { LocationProvider, useLocation } from './src/context/LocationContext';
import { AssignmentProvider, useAssignments } from './src/context/AssignmentContext';

// UI Shell
import { TopBar, TabDock, TabType, DOCK_CLEARANCE } from './src/components/ui/AppShell';
import { AmbientGlow, AppText, Button, Icon, Tappable } from './src/components/ui/primitives';
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
import { ProfileScreen, ProfileDataState } from './src/screens/ProfileScreen';

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
import { AvailabilityModal, LeavePeriod } from './src/components/AvailabilityModal';

/**
 * How recently a notification must have arrived for a launch to count as "opened from it".
 * Ten minutes comfortably covers seeing a banner and acting on it, without letting a tap
 * from days ago keep redirecting every future launch.
 */
const DEEP_LINK_MAX_AGE_MS = 10 * 60 * 1000;

function AppMain() {
  const theme = useTheme();
  const { isAuthenticated, user, assayerName, authenticating, login, biometricLogin, verifyIdentity, logout, clearMustChangePassword, locked, unlock } = useAuth();
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
  const [expenseSummary, setExpenseSummary] = useState<ExpenseSummary>({
    pending: 0,
    approved: 0,
    rejected: 0,
    totalClaimed: 0,
  });

  // Scanner modal state
  const [scannerModalVisible, setScannerModalVisible] = useState(false);
  const [activeScannerAssignment, setActiveScannerAssignment] = useState<AssayerAssignment | null>(null);

  // Return-paperwork (pdf docs) screen state
  const [pdfDocsAssignment, setPdfDocsAssignment] = useState<AssayerAssignment | null>(null);
  const [stagedPdf, setStagedPdf] = useState<{ name: string; base64: string } | null>(null);
  const [uploadingPdf, setUploadingPdf] = useState(false);

  // Query chat modal state
  const [queryChatModalVisible, setQueryChatModalVisible] = useState(false);
  const [queryChatAssignment, setQueryChatAssignment] = useState<AssayerAssignment | null>(null);

  // A tapped notification's target, held until `assignments` has actually loaded — a cold
  // start races the deep link against the assignment list fetch, so the target is queued
  // here and resolved by the effect below once real data exists to resolve it against.
  const [pendingNotificationTarget, setPendingNotificationTarget] = useState<{
    assignmentId?: string;
    category?: string;
  } | null>(null);

  // Navigation modal state
  const [navAssignment, setNavAssignment] = useState<AssayerAssignment | null>(null);

  // Rejection modal state
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [rejectAssignmentId, setRejectAssignmentId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  // Negotiate modal state
  const [negotiateModalVisible, setNegotiateModalVisible] = useState(false);
  const [negotiateAssignment, setNegotiateAssignment] = useState<AssayerAssignment | null>(null);

  // Expense modal state. The assignment a claim is filed against is tracked explicitly rather
  // than defaulting to assignments[0] — see the modal below.
  const [expenseModalVisible, setExpenseModalVisible] = useState(false);
  const [expenseAssignment, setExpenseAssignment] = useState<AssayerAssignment | null>(null);

  // Report-an-issue modal state — the assayer's channel to flag a problem to the desk.
  const [issueAssignment, setIssueAssignment] = useState<AssayerAssignment | null>(null);

  // Availability (self-service time off). Held separately from the profile form because it is
  // its own calendar UI, not a text field.
  const [availabilityVisible, setAvailabilityVisible] = useState(false);
  const [availabilityLeaves, setAvailabilityLeaves] = useState<LeavePeriod[]>([]);

  // Notification modal state
  const [notifModalVisible, setNotifModalVisible] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);

  // Profile data state
  const [profile, setProfile] = useState<ProfileDataState>({
    phone: '',
    alternatePhone: '',
    address: '',
    city: '',
    state: '',
    district: '',
    pincode: '',
    // Blank until the assayer's real address is geocoded or their device reports a fix.
    // A New Delhi default here silently became the stored home location for workers who
    // never edited the field, corrupting travel-distance and routing calculations.
    latitude: location?.latitude ?? 0,
    longitude: location?.longitude ?? 0,
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
    assayerCode: user?.assayerCode || '',
  });
  const [savingProfile, setSavingProfile] = useState(false);

  const seenNotifIdsRef = useRef<Set<string>>(new Set());
  /** False until the opening poll has recorded the existing backlog. */
  const hasPolledNotifsRef = useRef(false);

  const loadNotifications = useCallback(async () => {
    try {
      const items = await MobileApiService.getNotifications();
      setNotifications(items);
      setUnreadNotifCount(items.filter((n) => !n.isRead).length);

      /**
       * The first poll of a session only records what is already there.
       *
       * `seenNotifIdsRef` starts empty on every launch, so without this the opening poll
       * treats the entire unread backlog as "just arrived" and fires an alert for each —
       * open the app with twenty unread and twenty notifications land at once, for things
       * already visible on screen. Only genuinely new arrivals, seen while the app is
       * running, are worth interrupting for.
       */
      const isFirstLoad = !hasPolledNotifsRef.current;
      hasPolledNotifsRef.current = true;

      items.forEach((n) => {
        if (n.isRead || seenNotifIdsRef.current.has(n.id)) return;
        seenNotifIdsRef.current.add(n.id);
        if (isFirstLoad) return;
        triggerAlertNotification(
          n.title,
          n.message || 'New audit alert received',
          {
            notificationId: n.id,
            assignmentId: n.assignmentId,
            link: n.link,
          },
          // Picks the Android channel, so a polled notification is presented exactly as
          // loudly as the same notification would have been had it arrived as a push.
          (n as any).priority,
          // Chime only: polling runs only while the app is foregrounded, and the server has
          // already put this same notification in the tray via push.
          false,
        );
      });
    } catch (e) {
      console.error('Error loading notifications:', e);
    }
  }, []);

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
  const handleNotificationTap = useCallback((data: any) => {
    if (!data) return;
    if (data.notificationId) {
      MobileApiService.markNotificationRead(data.notificationId).catch(() => {});
    }
    const link: string = typeof data.link === 'string' ? data.link : '';

    // Money lives on its own tab and carries no assignment to select, so it returns early —
    // requiring an assignmentId below would drop these taps entirely.
    if (link.startsWith('/earnings')) {
      setPdfDocsAssignment(null);
      setSelectedTab('EARNINGS');
      return;
    }

    const assignmentId: string | undefined =
      data.entityId || (link ? link.replace('/assignments/', '') : undefined);
    if (!assignmentId) return;
    // Dismiss any open detail view too, or the tab change lands behind it and the tapped
    // notification appears to do nothing.
    setPdfDocsAssignment(null);
    setSelectedTab('SCHEDULE');
    setPendingNotificationTarget({ assignmentId, category: data.category });
  }, []);

  const loadAssayerProfile = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await MobileApiService.getAssayerProfile(user.id);
      if (res.success && res.data) {
        const p = res.data;
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
        setAvailabilityLeaves(
          Array.isArray(p.leaves)
            ? p.leaves
                .filter((l: any) => l?.startDate && l?.endDate)
                .map((l: any) => ({ startDate: String(l.startDate).slice(0, 10), endDate: String(l.endDate).slice(0, 10) }))
            : [],
        );
      }
    } catch (e) {
      console.error('Error fetching assayer profile:', e);
    }
  }, [user?.id]);

  const loadExpenseSummary = useCallback(async () => {
    if (!user?.id) return;
    const [summary, mine, stmt] = await Promise.all([
      MobileApiService.getMyExpenseSummary(),
      MobileApiService.getMyExpenses(),
      MobileApiService.getAssayerStatement(user.id),
    ]);
    setExpenseSummary(summary);
    setClaims(mine);
    setStatement(stmt);
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
      registerForPushNotificationsAsync();
      loadNotifications();
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

  // Push reliability across app state: this is the piece that was entirely missing.
  // `registerForPushNotificationsAsync` above got a token registered, but nothing was ever
  // listening for what happened to a notification afterward — not a tap, not even one that
  // arrived while the screen was open. `setupNotificationListeners` covers foreground and
  // background; `getLastNotificationResponseAsync` covers the one case listeners cannot,
  // launching fresh from a fully terminated state via a notification tap.
  useEffect(() => {
    if (!isAuthenticated) return;

    getLastNotificationResponseAsync().then((response) => {
      const data = response?.notification?.request?.content?.data;
      if (!data) return;

      /**
       * This call returns the last tapped notification *forever*, not only when that tap is
       * what launched the app. Every cold start replayed the same old tap, so the app always
       * opened on the schedule of whichever assignment was last notified about — the chosen
       * landing tab was silently overridden on launch, every launch.
       *
       * A tap that genuinely launched this session belongs to a recently-delivered
       * notification, so anything older than the window is treated as already handled.
       * Erring toward ignoring is the safe side: the notification list is still one tap away,
       * whereas a wrong redirect hijacks the whole app on every launch.
       */
      const deliveredAt = response?.notification?.date;
      const ageMs = typeof deliveredAt === 'number' ? Date.now() - deliveredAt : Infinity;
      if (ageMs > DEEP_LINK_MAX_AGE_MS) return;

      handleNotificationTap(data);
    });

    const unsubscribe = setupNotificationListeners(
      () => {
        // Received while the app is open — the OS banner is already configured to show
        // (see notification.service.ts's handler), so this only needs to keep the
        // in-app unread count and list from lagging behind it.
        loadNotifications();
      },
      (response: any) => {
        handleNotificationTap(response?.notification?.request?.content?.data);
      },
    );

    return unsubscribe;
  }, [isAuthenticated, handleNotificationTap, loadNotifications]);

  // Resolves a queued deep-link target once the assignment it points to has actually loaded —
  // opening the query chat is only meaningful once the app already knows about the query.
  useEffect(() => {
    if (!pendingNotificationTarget) return;
    const target = assignments.find((a) => a.id === pendingNotificationTarget.assignmentId);
    if (!target) return;

    if (pendingNotificationTarget.category === 'VALIDATION' && target.queries?.length) {
      setQueryChatAssignment(target);
      setQueryChatModalVisible(true);
    }
    setPendingNotificationTarget(null);
  }, [pendingNotificationTarget, assignments]);

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
    if (!rejectAssignmentId || rejectSubmitting) return;
    setRejectSubmitting(true);
    try {
      const res = await rejectAssignment(rejectAssignmentId, rejectReason || 'Declined by assayer');
      if (res.success) {
        setRejectModalVisible(false);
        setRejectAssignmentId(null);
        setRejectReason('');
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
    } finally {
      setBusyActionId(null);
    }
  };

  const handleUpdateProfileField = (field: keyof ProfileDataState, value: any) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    try {
      if (!user?.id) {
        feedback.error('Not signed in', 'Sign in again before saving your profile.');
        return;
      }
      // `updateAssayerProfile` reports failure by return value, not by throwing, so the catch
      // below never saw a rejected save. This claimed "Profile saved successfully" on a 404 —
      // and the endpoint it called did not exist, so that is what every save did.
      const result = await MobileApiService.updateAssayerProfile(user.id, profile);
      if (!result.success) {
        feedback.error('Not saved', result.error || 'Your profile could not be saved. Please try again.');
        return;
      }
      feedback.success('Profile saved');
    } catch (e: any) {
      feedback.error('Not saved', e?.message || 'Your profile could not be saved.');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleOpenPdfDocs = useCallback((a: AssayerAssignment) => {
    setPdfDocsAssignment(a);
    setStagedPdf(null);
  }, []);

  const handleClosePdfDocs = useCallback(() => {
    setPdfDocsAssignment(null);
    setStagedPdf(null);
    setUploadingPdf(false);
  }, []);

  /**
   * The assignment detail view replaces the whole tab body, so it needs a way out.
   *
   * It had none: no back control was rendered, and switching tabs did not clear it either —
   * `pdfDocsAssignment` stayed set, so the detail view kept winning over whichever tab was
   * selected. Opening any assignment left the app with no route back short of force-closing it.
   */
  /**
   * Every tab shares one ScrollView, so its offset carried over between them: scrolling to the
   * bottom of the schedule and then opening Earnings landed you halfway down a screen you had
   * never scrolled, with the top of it — the balance — off-screen.
   */
  const scrollRef = useRef<ScrollView>(null);

  const handleSelectTab = useCallback((tab: TabType) => {
    setPdfDocsAssignment(null);
    setSelectedTab(tab);
    // Tapping the tab you are already on returns you to the top of it, which is the
    // convention everywhere else and the only way back up a long schedule without dragging.
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [selectedTab, pdfDocsAssignment]);

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
      if (pdfDocsAssignment) {
        handleClosePdfDocs();
        return true;
      }
      if (selectedTab !== 'HOME') {
        setSelectedTab('HOME');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [pdfDocsAssignment, handleClosePdfDocs, selectedTab]);

  const handleSelectPdfFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const base64 = await assetToBase64(asset);
      const name = asset.name || 'audit_packet.pdf';
      setStagedPdf({ name, base64 });
      feedback.success('PDF attached', `${name} is ready to submit.`);
    } catch (err: any) {
      feedback.error('File Picker Error', err?.message || 'Failed to select a PDF file.');
    }
  }, []);

  const uploadPdf = useCallback((target: AssayerAssignment, name: string, base64: string) => {
    setUploadingPdf(true);
    return MobileApiService.uploadCompletedAuditPdf(target.id, name, { base64 }, target.id)
      .then((res) => {
        if (res?.success) {
          setStagedPdf({ name, base64 });
          feedback.success('Upload Complete', `${name} was uploaded successfully.`);
          void refreshAfterServerChange();
        } else {
          feedback.error('Upload Failed', res?.error || 'The document could not be uploaded.');
        }
        return res?.success ?? false;
      })
      .catch(() => {
        feedback.error('Upload Failed', 'The document could not be uploaded. Please try again.');
        return false;
      })
      .finally(() => setUploadingPdf(false));
  }, []);

  const handleSubmitCompletedPdf = useCallback(() => {
    if (!pdfDocsAssignment) return;
    if (!stagedPdf) {
      feedback.warning('Nothing to submit', 'Attach a PDF or scan the pages first.');
      return;
    }
    uploadPdf(pdfDocsAssignment, stagedPdf.name, stagedPdf.base64).then((ok) => {
      if (ok) handleClosePdfDocs();
    });
  }, [pdfDocsAssignment, stagedPdf, uploadPdf, handleClosePdfDocs]);

  if (authenticating) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
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
        <LockScreen name={assayerName} onUnlock={unlock} onSignOut={logout} />
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

  const totalEarnings = assignments
    .filter((a) => a.status === 'COMPLETED')
    .reduce((sum, a) => sum + getAssignmentTotalFee(a), 0);

  const pendingEarnings = assignments
    .filter((a) => a.status !== 'COMPLETED' && a.status !== 'REJECTED')
    .reduce((sum, a) => sum + getAssignmentTotalFee(a), 0);

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
        onNotifications={() => { loadNotifications(); setNotifModalVisible(true); }}
        onOpenProfile={() => handleSelectTab('MY_PROFILE')}
      />

      {/* Main Content Area — keyboard-avoiding so the Profile/Work form fields below the
          fold scroll into view instead of sitting under the on-screen keyboard. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
        {pdfDocsAssignment ? (
          <>
          <Tappable
            onPress={handleClosePdfDocs}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space.sm,
              paddingVertical: theme.space.md,
            }}
          >
            <Icon name="arrow-back" size={20} color={theme.colors.primary} />
            <AppText variant="bodyStrong" tone="primary">
              {pdfDocsAssignment.branchName || 'Back'}
            </AppText>
          </Tappable>
          <PdfDocsScreen
            activeAssignment={pdfDocsAssignment}
            uploadedPdfName={stagedPdf?.name ?? null}
            uploadingPdf={uploadingPdf}
            onSelectPdfFile={handleSelectPdfFile}
            onOpenScanner={() => {
              setActiveScannerAssignment(pdfDocsAssignment);
              setScannerModalVisible(true);
            }}
            onSubmitCompletedPdf={handleSubmitCompletedPdf}
            onOpenExpenseModal={() => {
              // Claim is filed against the assignment whose paperwork is open — the one the
              // assayer is demonstrably working on.
              setExpenseAssignment(pdfDocsAssignment);
              setExpenseModalVisible(true);
            }}
            onReportIssue={() => setIssueAssignment(pdfDocsAssignment)}
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
            runningBalance={Number(profile.runningBalance) || 0}
            expenseSummary={expenseSummary}
            onOpenAssignment={handleOpenPdfDocs}
            onCheckIn={handleCheckIn}
            onScan={(a) => {
              setActiveScannerAssignment(a);
              setScannerModalVisible(true);
            }}
            onNavigate={(a) => setNavAssignment(a)}
            onAcceptOffer={(a) => handleAcceptAssignment(a.id)}
            onDeclineOffer={(a) => {
              setRejectAssignmentId(a.id);
              setRejectModalVisible(true);
            }}
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
            onOpenRejectModal={(id) => {
              setRejectAssignmentId(id);
              setRejectModalVisible(true);
            }}
            onCheckIn={handleCheckIn}
            onOpenPdfDocs={(a) => {
              handleOpenPdfDocs(a);
            }}
            onOpenScanner={(a) => {
              setActiveScannerAssignment(a);
              setScannerModalVisible(true);
            }}
            onOpenQueryChat={(a) => {
              setQueryChatAssignment(a);
              setQueryChatModalVisible(true);
            }}
            onOpenMap={(a) => {
              setNavAssignment(a);
            }}
            onCounterOffer={(a) => {
              setNegotiateAssignment(a);
              setNegotiateModalVisible(true);
            }}
          />
        )}

        {selectedTab === 'QUERIES' && (
          <QueriesScreen
            assignments={assignments}
            onOpenQueryChat={(a) => {
              setQueryChatAssignment(a);
              setQueryChatModalVisible(true);
            }}
          />
        )}

        {selectedTab === 'EARNINGS' && (
          <EarningsScreen
            totalEarnings={totalEarnings}
            pendingEarnings={pendingEarnings}
            runningBalance={Number(profile.runningBalance) || 0}
            earningsPaid={Number(profile.earningsPaid) || 0}
            earningsAwaitingApproval={Number(profile.earningsAwaitingApproval) || 0}
            assignments={assignments}
            claims={claims}
            claimSummary={expenseSummary}
            statement={statement}
            onOpenExpenseModal={() => {
              // From the Earnings tab there is no open job, so tie the claim to the one the
              // assayer is currently on (checked in / in progress / accepted). If there is
              // none, the modal explains it must be filed from the assignment.
              const active = assignments.find(
                (a) => a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS' || a.status === 'ACCEPTED',
              );
              setExpenseAssignment(active ?? null);
              setExpenseModalVisible(true);
            }}
          />
        )}

        {selectedTab === 'MY_PROFILE' && (
          <ProfileScreen
            assayerName={assayerName}
            assayerCode={user?.assayerCode || profile.assayerCode}
            profile={profile}
            savingProfile={savingProfile}
            openQueries={assignments.reduce((n, a) => n + (a.queries || []).filter((q: any) => q.status !== 'RESOLVED' && q.status !== 'CLOSED').length, 0)}
            resolvedQueries={assignments.reduce((n, a) => n + (a.queries || []).filter((q: any) => q.status === 'RESOLVED' || q.status === 'CLOSED').length, 0)}
            onUpdateProfileField={handleUpdateProfileField}
            onSaveProfile={handleSaveProfile}
            onOpenAvailability={() => setAvailabilityVisible(true)}
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
        visible={rejectModalVisible}
        rejectReason={rejectReason}
        submitting={rejectSubmitting}
        onChangeReason={setRejectReason}
        onConfirm={handleConfirmReject}
        onCancel={() => {
          setRejectModalVisible(false);
          setRejectAssignmentId(null);
        }}
      />

      {scannerModalVisible && (
        <DocumentScanner
          visible={scannerModalVisible}
          purpose="Audited return for this assignment"
          onClose={() => {
            setScannerModalVisible(false);
            setActiveScannerAssignment(null);
          }}
          onSaved={async (doc) => {
            const assignment = activeScannerAssignment;
            setScannerModalVisible(false);
            setActiveScannerAssignment(null);
            if (!assignment) {
              feedback.error('Upload Failed', 'No assignment was selected for this upload.');
              return;
            }

            /**
             * One upload for the whole packet.
             *
             * This used to loop over the pages and POST each one separately, producing N
             * unrelated `AUDITED_RETURN_PDF` rows named `..._p1of6.jpg` — six loose JPEGs
             * where the desk expected one document, each triggering its own assignment
             * completion. ML Kit now assembles the pages into a single PDF on-device, so
             * the evidence arrives as one file that matches what the record claims to hold.
             */
            if (doc.pdfUri) {
              /**
               * Resumable, because this is the upload that matters and the worst place to be
               * when it fails: a multi-megabyte scan going out over rural mobile data at the
               * end of a branch visit. A drop now costs only the unsent chunks.
               */
              feedback.info('Uploading', `Sending ${doc.fileName}…`);
              const res = await MobileApiService.uploadAuditPdfResumable(
                assignment.id,
                doc.fileName,
                doc.pdfUri,
                assignment.id,
              ).catch((err: any) => ({ success: false, error: err?.message }));

              if (res?.success) {
                feedback.success('Upload complete', `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} uploaded as ${doc.fileName}.`);
                // Filing the return moves the assignment on server-side (see
                // completeAssignmentForReturn). Without this the app kept showing the job as
                // still needing a scan, and the assayer could upload the same packet twice.
                await refreshAfterServerChange();
              } else {
                feedback.error(
                  'Upload failed',
                  `${doc.fileName} was not uploaded${res?.error ? `: ${res.error}` : ''}. Please retry before leaving the branch.`,
                );
              }
              return;
            }

            /**
             * Image fallback for the platforms with no ML Kit PDF (iOS, web, attached files).
             * Still reports partial failure honestly — a half-delivered evidence packet that
             * announces success is worse than one that fails loudly.
             */
            const total = doc.pages.length;
            const failed: number[] = [];
            for (const pg of doc.pages) {
              const base = doc.fileName.replace(/\.[^.]+$/, '');
              const name = total === 1 ? doc.fileName : `${base}_p${pg.pageNumber}of${total}.jpg`;
              try {
                const res = await MobileApiService.uploadCompletedAuditPdf(
                  assignment.id,
                  name,
                  { uri: pg.uri },
                  assignment.id,
                );
                if (!res?.success) failed.push(pg.pageNumber);
              } catch {
                failed.push(pg.pageNumber);
              }
            }

            await refreshAfterServerChange();

            if (failed.length === 0) {
              feedback.success('Upload complete', `All ${total} page${total === 1 ? '' : 's'} were uploaded.`);
            } else {
              feedback.warning(
                'Some pages did not upload',
                `${total - failed.length} of ${total} uploaded. Page${failed.length === 1 ? '' : 's'} ${failed.join(', ')} failed — please scan ${failed.length === 1 ? 'it' : 'them'} again before leaving the branch.`,
              );
            }
          }}
        />
      )}

      {queryChatModalVisible && queryChatAssignment && (
        <AssayerQueryChatModal
          visible={queryChatModalVisible}
          assignment={queryChatAssignment}
          onClose={() => {
            setQueryChatModalVisible(false);
            setQueryChatAssignment(null);
          }}
        />
      )}

      {/* Voice-call UI, mounted once at root like the navigation modal. Renders nothing
          while no call exists; the calls service's store drives it entirely. */}
      <CallModal />

      {navAssignment && (
        <InAppNavigationModal
          visible={Boolean(navAssignment)}
          assignment={navAssignment}
          onClose={() => setNavAssignment(null)}
        />
      )}

      {notifModalVisible && (
        <NotificationsModal
          visible={notifModalVisible}
          notifications={notifications}
          unreadCount={unreadNotifCount}
          onClose={() => setNotifModalVisible(false)}
          onMarkRead={(id) => {
            // Marked read locally first so the list responds immediately, then reverted if the
            // server disagrees. Previously the result was discarded entirely (behind a `.then`
            // that did nothing), so a failed call left the row looking read until the next
            // reload quietly brought it back.
            setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
            setUnreadNotifCount((c) => Math.max(0, c - 1));

            MobileApiService.markNotificationRead(id)
              .then((ok) => {
                if (ok) return;
                setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)));
                setUnreadNotifCount((c) => c + 1);
              })
              .catch(() => {
                setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)));
                setUnreadNotifCount((c) => c + 1);
              });
          }}
          onTapNotification={(n) => {
            setNotifModalVisible(false);
            if (n.link) handleNotificationTap({ notificationId: n.id, entityId: n.assignmentId, link: n.link });
          }}
        />
      )}

      {expenseModalVisible && (
        <ExpenseModal
          visible={expenseModalVisible}
          onClose={() => setExpenseModalVisible(false)}
          onAddExpense={async (category, amount, description) => {
            // Against the assignment chosen at the entry point, never assignments[0]. The old
            // code filed every claim against whatever assignment happened to sort first — so a
            // travel claim for today's branch could land on a completed job from weeks ago, and
            // with an empty list it was silently dropped with no error.
            if (!expenseAssignment?.id) {
              feedback.error(
                'No assignment selected',
                'Open the assignment you are claiming for and file the expense from there.',
              );
              return;
            }
            const res = await submitExpense(expenseAssignment.id, {
              category: category as any,
              amount: Number(amount) || 0,
              description,
            });
            if (res.success) {
              feedback.success('Claim filed', `₹${amount} for ${category} is awaiting approval.`);
              setExpenseModalVisible(false);
              // Pull the totals back so the new claim shows on Home immediately rather
              // than only after the next manual pull-to-refresh.
              loadExpenseSummary();
            } else {
              feedback.error('Claim not filed', res.error || 'The expense could not be submitted.');
            }
          }}
        />
      )}

      {issueAssignment && (
        <ReportIssueModal
          visible={!!issueAssignment}
          assignment={issueAssignment}
          onClose={() => setIssueAssignment(null)}
          onSubmit={async (category, note) => {
            const res = await MobileApiService.reportAssignmentIssue(issueAssignment.id, category, note);
            if (res.success) {
              feedback.success('Reported to desk', 'The operations team has been notified and will follow up.');
              return true;
            }
            feedback.error('Not sent', res.error || 'The issue could not be reported. Please try again.');
            return false;
          }}
        />
      )}

      {availabilityVisible && (
        <AvailabilityModal
          visible={availabilityVisible}
          initialLeaves={availabilityLeaves}
          onClose={() => setAvailabilityVisible(false)}
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

      {negotiateModalVisible && negotiateAssignment && (
        <NegotiateModal
          visible={negotiateModalVisible}
          // Pass the real fee (0 when unresolved), not `|| 1800`. The modal seeds an empty
          // counter-offer box for a non-positive fee on purpose; injecting 1800 here defeated
          // that guard and re-fabricated the phantom asking price it exists to prevent.
          currentFee={negotiateAssignment.proposedFee || 0}
          onCancel={() => {
            setNegotiateModalVisible(false);
            setNegotiateAssignment(null);
          }}
          onSubmit={async (counterFee, remarks) => {
            const res = await updateAssignmentStatus(
              negotiateAssignment.id,
              'PENDING',
              remarks,
              { proposedFee: counterFee }
            );
            if (res.success) {
              feedback.success(
                'Counter-Offer Submitted',
                `Your proposed fee of ₹${counterFee.toLocaleString('en-IN')} has been sent to Operations.`
              );
              setNegotiateModalVisible(false);
              setNegotiateAssignment(null);
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
      return (
        <SafeAreaView style={{ flex: 1, backgroundColor: '#0E1016', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <StatusBar barStyle="light-content" />
          <View style={{ gap: 12, alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#8B7CFF" />
            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '700' }}>Orbit</Text>
            <Text style={{ color: '#ef4444', textAlign: 'center', marginVertical: 10 }}>
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
    return (
      <ThemeProvider>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0E1016' }}>
          <ActivityIndicator color="#8B7CFF" />
        </View>
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
