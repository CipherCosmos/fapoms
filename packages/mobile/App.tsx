import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SafeAreaView, ScrollView, View, ActivityIndicator, Alert, StatusBar, RefreshControl, Text } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { registerRootComponent } from 'expo';
import { AssayerAssignment, AppNotification } from './src/types/mobile-app';
import { MobileApiService } from './src/services/api.service';
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

// Screens
import { LoginScreen } from './src/screens/LoginScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { PdfDocsScreen } from './src/screens/PdfDocsScreen';
import { QueriesScreen } from './src/screens/QueriesScreen';
import { EarningsScreen } from './src/screens/EarningsScreen';
import { ProfileScreen, ProfileDataState } from './src/screens/ProfileScreen';

// Modals
import { NotificationsModal } from './src/components/NotificationsModal';
import { MLKitScannerModal } from './src/components/MLKitScannerModal';
import { AssayerQueryChatModal } from './src/components/AssayerQueryChatModal';
import { InAppNavigationModal } from './src/components/InAppNavigationModal';
import { RejectionModal } from './src/components/RejectionModal';
import { ExpenseModal } from './src/components/ExpenseModal';
import { NegotiateModal } from './src/components/NegotiateModal';

function AppMain() {
  const theme = useTheme();
  const { isAuthenticated, user, assayerName, authenticating, login, biometricLogin, verifyIdentity, logout } = useAuth();
  const { location, refreshLocation } = useLocation();
  const { assignments, loadAssignments, updateAssignmentStatus, rejectAssignment, submitExpense } = useAssignments();

  const [selectedTab, setSelectedTab] = useState<TabType>('SCHEDULE');
  const [refreshing, setRefreshing] = useState(false);

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
    latitude: location?.latitude || 28.6315,
    longitude: location?.longitude || 77.2167,
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

  useEffect(() => {
    if (isAuthenticated) {
      registerForPushNotificationsAsync();
      loadNotifications();
      loadAssayerProfile();

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
    await Promise.all([loadAssignments(), refreshLocation(), loadNotifications(), loadAssayerProfile()]);
    setRefreshing(false);
  };

  const handleAcceptAssignment = async (id: string) => {
    const res = await updateAssignmentStatus(id, 'ACCEPTED');
    if (!res.success) {
      Alert.alert('Error', res.error || 'Failed to accept assignment');
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
      Alert.alert('Error', res.error || 'Failed to reject assignment');
    }
  };

  const handleCheckIn = async (assignment: AssayerAssignment) => {
    const lat = location?.latitude || assignment.latitude || 28.6315;
    const lng = location?.longitude || assignment.longitude || 77.2167;
    const res = await MobileApiService.checkInBranch(assignment.id, lat, lng);
    if (res.success) {
      await loadAssignments();
      Alert.alert('Checked In', `Checked in at ${assignment.branchName}`);
    } else {
      Alert.alert('Error', res.error || 'Check-in failed');
    }
  };

  const handleUpdateProfileField = (field: keyof ProfileDataState, value: any) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    try {
      if (user?.id) {
        await MobileApiService.updateAssayerProfile(user.id, profile);
      }
      Alert.alert('Success', 'Profile saved successfully');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to save profile');
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
      Alert.alert('PDF attached', `${name} is ready to submit.`);
    } catch (err: any) {
      Alert.alert('File Picker Error', err?.message || 'Failed to select a PDF file.');
    }
  }, []);

  const uploadPdf = useCallback((target: AssayerAssignment, name: string, base64: string) => {
    setUploadingPdf(true);
    return MobileApiService.uploadCompletedAuditPdf(target.id, name, { base64 }, target.id)
      .then((res) => {
        if (res?.success) {
          setStagedPdf({ name, base64 });
          Alert.alert('Upload Complete', `${name} was uploaded successfully.`);
        } else {
          Alert.alert('Upload Failed', res?.error || 'The document could not be uploaded.');
        }
        return res?.success ?? false;
      })
      .catch(() => {
        Alert.alert('Upload Failed', 'The document could not be uploaded. Please try again.');
        return false;
      })
      .finally(() => setUploadingPdf(false));
  }, []);

  const handleSubmitCompletedPdf = useCallback(() => {
    if (!pdfDocsAssignment) return;
    if (!stagedPdf) {
      Alert.alert('Nothing to submit', 'Attach a PDF or scan the pages first.');
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
            const finalU = (u || '').trim() || 'AS0127';
            const finalP = (p || '').trim() || 'Password@123';
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

  const queryCount = assignments.filter((a) => a.queries && a.queries.length > 0).length;

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
            assignments={assignments}
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
        <MLKitScannerModal
          visible={scannerModalVisible}
          onClose={() => {
            setScannerModalVisible(false);
            setActiveScannerAssignment(null);
          }}
          onPdfGenerated={(pdfName, base64Pdf) => {
            const assignment = activeScannerAssignment;
            setScannerModalVisible(false);
            setActiveScannerAssignment(null);
            if (!assignment) {
              Alert.alert('Upload Failed', 'No assignment was selected for this upload.');
              return;
            }
            Alert.alert('Scan Completed', `Document ${pdfName} captured. Uploading…`);
            MobileApiService.uploadCompletedAuditPdf(
              assignment.id,
              pdfName,
              { base64: base64Pdf },
              assignment.id,
            ).then((res) => {
              if (res?.success) {
                Alert.alert('Upload Complete', `${pdfName} was uploaded successfully.`);
              } else {
                Alert.alert('Upload Failed', res?.error || 'The document could not be uploaded.');
              }
            }).catch(() => {
              Alert.alert('Upload Failed', 'The document could not be uploaded. Please try again.');
            });
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
            MobileApiService.markNotificationRead(id)
              .then((ok) => { if (!ok) return; })
              .catch(() => {});
            setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
            setUnreadNotifCount((c) => Math.max(0, c - 1));
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
                Alert.alert('Expense Logged', `Logged ₹${amount} for ${category}`);
                setExpenseModalVisible(false);
              } else {
                Alert.alert('Error', res.error || 'Failed to submit expense');
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
              Alert.alert(
                'Counter-Offer Submitted',
                `Your proposed fee of ₹${counterFee.toLocaleString('en-IN')} has been sent to Operations.`
              );
              setNegotiateModalVisible(false);
              setNegotiateAssignment(null);
            } else {
              Alert.alert('Error', res.error || 'Failed to submit counter-offer.');
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
        <SafeAreaView style={{ flex: 1, backgroundColor: '#0A101C', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <StatusBar barStyle="light-content" />
          <View style={{ gap: 12, alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#6366f1" />
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
  return (
    <ThemeProvider>
      <AppErrorBoundary>
        <AuthProvider>
          <LocationProvider>
            <AssignmentProvider>
              <AppMain />
            </AssignmentProvider>
          </LocationProvider>
        </AuthProvider>
      </AppErrorBoundary>
    </ThemeProvider>
  );
}

registerRootComponent(App);
