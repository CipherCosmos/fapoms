import React, { useState, useEffect, useCallback } from 'react';
import { SafeAreaView, ScrollView, View, ActivityIndicator, Alert, StatusBar, RefreshControl, Text } from 'react-native';
import { registerRootComponent } from 'expo';
import { AssayerAssignment, AppNotification } from './src/types/mobile-app';
import { MobileApiService } from './src/services/api.service';
import { registerForPushNotificationsAsync } from './src/services/notification.service';
import { getAssignmentTotalFee } from './src/utils/fees';

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
import { QueriesScreen } from './src/screens/QueriesScreen';
import { EarningsScreen } from './src/screens/EarningsScreen';
import { ProfileScreen, ProfileDataState } from './src/screens/ProfileScreen';

// Modals
import { NotificationDetailModal } from './src/components/NotificationDetailModal';
import { MLKitScannerModal } from './src/components/MLKitScannerModal';
import { AssayerQueryChatModal } from './src/components/AssayerQueryChatModal';
import { InAppNavigationModal } from './src/components/InAppNavigationModal';
import { RejectionModal } from './src/components/RejectionModal';
import { ExpenseModal } from './src/components/ExpenseModal';

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

  // Query chat modal state
  const [queryChatModalVisible, setQueryChatModalVisible] = useState(false);
  const [queryChatAssignment, setQueryChatAssignment] = useState<AssayerAssignment | null>(null);

  // Navigation modal state
  const [navAssignment, setNavAssignment] = useState<AssayerAssignment | null>(null);

  // Rejection modal state
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [rejectAssignmentId, setRejectAssignmentId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

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

  const loadNotifications = useCallback(async () => {
    try {
      const items = await MobileApiService.getNotifications();
      setNotifications(items);
      setUnreadNotifCount(items.filter((n) => !n.isRead).length);
    } catch (e) {
      console.error('Error loading notifications:', e);
    }
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
    const res = await updateAssignmentStatus(assignment.id, 'CHECKED_IN');
    if (res.success) {
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
            if (u && p) {
              const res = await login(u, p);
              return res.success;
            }
          }}
          onVerifyIdentity={verifyIdentity}
          onBiometricLogin={async () => {
            const res = await biometricLogin();
            return res.success;
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
        onNotifications={() => setNotifModalVisible(true)}
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
              setActiveScannerAssignment(a);
              setScannerModalVisible(true);
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
          onPdfGenerated={(pdfName) => {
            setScannerModalVisible(false);
            setActiveScannerAssignment(null);
            Alert.alert('Scan Completed', `Document ${pdfName} saved successfully.`);
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
        <NotificationDetailModal
          visible={notifModalVisible}
          assignment={assignments[0] || null}
          onClose={() => setNotifModalVisible(false)}
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
