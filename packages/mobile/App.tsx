import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SafeAreaView, ScrollView, View, ActivityIndicator, Alert, StatusBar, RefreshControl, Text } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { AssayerAssignment, AppNotification, AssayerExpense, ExpenseSummary } from './src/types/mobile-app';
import { MobileApiService, initApiBaseUrl } from './src/services/api.service';
import {
  registerForPushNotificationsAsync,
  setupNotificationListeners,
  getLastNotificationResponseAsync,
  triggerAlertNotification,
} from './src/services/notification.service';
import { getAssignmentTotalFee } from './src/utils/fees';
import { assetToBase64 } from './src/utils/pickDocument';

// Context Providers
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { LocationProvider, useLocation } from './src/context/LocationContext';
import { AssignmentProvider, useAssignments } from './src/context/AssignmentContext';

// UI Shell
import { TopBar, TabDock, TabType, DOCK_CLEARANCE } from './src/components/ui/AppShell';
import { AppText, Button } from './src/components/ui/primitives';
import { FeedbackProvider, useFeedback } from './src/components/ui/Feedback';

// Screens
import { LoginScreen } from './src/screens/LoginScreen';
import { ChangePasswordScreen } from './src/screens/ChangePasswordScreen';
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
import { RejectionModal } from './src/components/RejectionModal';
import { ExpenseModal } from './src/components/ExpenseModal';
import { NegotiateModal } from './src/components/NegotiateModal';

function AppMain() {
  const theme = useTheme();
  const { isAuthenticated, user, assayerName, authenticating, login, biometricLogin, verifyIdentity, logout, clearMustChangePassword } = useAuth();
  const { location, refreshLocation } = useLocation();
  const { assignments, loadAssignments, updateAssignmentStatus, rejectAssignment, submitExpense } = useAssignments();

  const [selectedTab, setSelectedTab] = useState<TabType>('HOME');
  const [refreshing, setRefreshing] = useState(false);
  const feedback = useFeedback();
  /**
   * Claim totals, read back from the server.
   *
   * The app could file an expense but never see one again — `/expenses/mine/summary` existed
   * from the start and nothing called it, so an assayer had no way to tell an approved claim
   * from a rejected one.
   */
  const [claims, setClaims] = useState<AssayerExpense[]>([]);
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

  // Negotiate modal state
  const [negotiateModalVisible, setNegotiateModalVisible] = useState(false);
  const [negotiateAssignment, setNegotiateAssignment] = useState<AssayerAssignment | null>(null);

  // Expense modal state
  const [expenseModalVisible, setExpenseModalVisible] = useState(false);

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

  const loadNotifications = useCallback(async () => {
    try {
      const items = await MobileApiService.getNotifications();
      setNotifications(items);
      setUnreadNotifCount(items.filter((n) => !n.isRead).length);

      // Trigger audio chime & push alert for newly received unread notifications
      items.forEach((n) => {
        if (!n.isRead && !seenNotifIdsRef.current.has(n.id)) {
          seenNotifIdsRef.current.add(n.id);
          triggerAlertNotification(n.title, n.message || 'New audit alert received', {
            notificationId: n.id,
            assignmentId: n.assignmentId,
            link: n.link,
          });
        }
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
   * the best a fixed shell can do: land on the Schedule tab for anything assignment-shaped,
   * and additionally open the query chat directly when the notification was specifically about
   * a raised clarification — since that is the one case where "just look at your schedule"
   * would leave the person hunting for the actual question.
   */
  const handleNotificationTap = useCallback((data: any) => {
    if (!data) return;
    if (data.notificationId) {
      MobileApiService.markNotificationRead(data.notificationId).catch(() => {});
    }
    const assignmentId: string | undefined =
      data.entityId || (typeof data.link === 'string' ? data.link.replace('/assignments/', '') : undefined);
    if (!assignmentId) return;
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
      }
    } catch (e) {
      console.error('Error fetching assayer profile:', e);
    }
  }, [user?.id]);

  const loadExpenseSummary = useCallback(async () => {
    if (!user?.id) return;
    const [summary, mine] = await Promise.all([
      MobileApiService.getMyExpenseSummary(),
      MobileApiService.getMyExpenses(),
    ]);
    setExpenseSummary(summary);
    setClaims(mine);
  }, [user?.id]);

  useEffect(() => {
    if (isAuthenticated) {
      registerForPushNotificationsAsync();
      loadNotifications();
      loadAssayerProfile();
      loadExpenseSummary();

      // Silent background auto-refresh every 30 seconds
      const timer = setInterval(() => {
        loadAssignments();
        loadNotifications();
      }, 30000);

      return () => clearInterval(timer);
    }
  }, [isAuthenticated, loadNotifications, loadAssayerProfile, loadAssignments]);

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
      if (data) handleNotificationTap(data);
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
    const res = await updateAssignmentStatus(id, 'ACCEPTED');
    if (!res.success) {
      feedback.error('Not accepted', res.error || 'The assignment could not be accepted.');
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectAssignmentId) return;
    const res = await rejectAssignment(rejectAssignmentId, rejectReason || 'Declined by assayer');
    if (res.success) {
      setRejectModalVisible(false);
      setRejectAssignmentId(null);
      setRejectReason('');
    } else {
      feedback.error('Not declined', res.error || 'The assignment could not be declined.');
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

    const res = await MobileApiService.checkInBranch(assignment.id, fix.latitude, fix.longitude, fix.accuracy ?? undefined);
    if (res.success) {
      await loadAssignments();
      feedback.success('Checked In', `Checked in at ${assignment.branchName}`);
    } else {
      feedback.error('Could not check in', res.error || 'Check-in failed. Please try again.');
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
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} />
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
   * An account still holding an issued password sees only the change-password screen.
   *
   * Placed after the authentication gate because changing a password requires a session, and
   * before every other screen because audit work must not be done under a credential that
   * two dozen people share.
   */
  if (user?.mustChangePassword) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} />
        <ChangePasswordScreen onChanged={clearMustChangePassword} onLogout={logout} />
      </SafeAreaView>
    );
  }

  const queryCount = assignments.filter((a) => (a.queries || []).some((q) => q.status !== 'RESOLVED')).length;

  const totalEarnings = assignments
    .filter((a) => a.status === 'COMPLETED')
    .reduce((sum, a) => sum + getAssignmentTotalFee(a), 0);

  const pendingEarnings = assignments
    .filter((a) => a.status !== 'COMPLETED' && a.status !== 'REJECTED')
    .reduce((sum, a) => sum + getAssignmentTotalFee(a), 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} />

      {/* Header */}
      <TopBar
        name={assayerName}
        subtitle={profile.assayerCode ? `Code: ${profile.assayerCode}` : (user?.assayerCode ? `Code: ${user.assayerCode}` : 'Field Assayer')}
        unreadCount={unreadNotifCount}
        onNotifications={() => { loadNotifications(); setNotifModalVisible(true); }}
        onRefresh={handleRefresh}
        refreshing={refreshing}
      />

      {/* Main Content Area */}
      <ScrollView
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
            onOpenExpenseModal={() => setExpenseModalVisible(true)}
          />
        ) : (
        <>
        {selectedTab === 'HOME' && (
          <HomeScreen
            assayerName={user?.name || 'Assayer'}
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
            onSeeSchedule={() => setSelectedTab('SCHEDULE')}
            onSeeQueries={() => setSelectedTab('QUERIES')}
          />
        )}

        {selectedTab === 'SCHEDULE' && (
          <ScheduleScreen
            assignments={assignments}
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
            onOpenExpenseModal={() => setExpenseModalVisible(true)}
          />
        )}

        {selectedTab === 'MY_PROFILE' && (
          <ProfileScreen
            assayerName={assayerName}
            assayerCode={user?.assayerCode || profile.assayerCode}
            profile={profile}
            savingProfile={savingProfile}
            onUpdateProfileField={handleUpdateProfileField}
            onSaveProfile={handleSaveProfile}
            onLogout={logout}
          />
        )}
        </>
        )}
      </ScrollView>

      {/* Floating Animated Navigation Dock */}
      <TabDock selected={selectedTab} onSelect={setSelectedTab} queryCount={queryCount} />

      {/* Modals */}
      <RejectionModal
        visible={rejectModalVisible}
        rejectReason={rejectReason}
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
            if (assignments[0]?.id) {
              const res = await submitExpense(assignments[0].id, {
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
            } else {
              setExpenseModalVisible(false);
            }
          }}
        />
      )}

      {negotiateModalVisible && negotiateAssignment && (
        <NegotiateModal
          visible={negotiateModalVisible}
          currentFee={negotiateAssignment.proposedFee || 1800}
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
        <SafeAreaView style={{ flex: 1, backgroundColor: '#121014', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <StatusBar barStyle="light-content" />
          <View style={{ gap: 12, alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#FF6B00" />
            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '700' }}>FAPOMS Field Assayer</Text>
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
    initApiBaseUrl()
      .catch(() => { /* falls back to the built-in default */ })
      .finally(() => setApiReady(true));
  }, []);

  if (!apiReady) {
    return (
      <ThemeProvider>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#121014' }}>
          <ActivityIndicator color="#FF8534" />
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
