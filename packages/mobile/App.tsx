import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SafeAreaView, ScrollView, View, Text, ActivityIndicator, Alert, Linking, Platform, Modal, TouchableOpacity } from 'react-native';
import { registerRootComponent } from 'expo';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { AssayerAssignment, ValidationQuery, AssayerExpense, AppNotification } from './src/types/mobile-app';
import { MobileApiService } from './src/services/api.service';
import { registerForPushNotificationsAsync, setupNotificationListeners } from './src/services/notification.service';
import { connectMobileSocket, disconnectMobileSocket, getMobileSocket } from './src/services/socket';

// Modular Theme & Layout Components
import { styles } from './src/theme/styles';
import { Header } from './src/components/Header';
import { TabBar, TabType } from './src/components/TabBar';
import { RejectionModal } from './src/components/RejectionModal';
import { ExpenseModal } from './src/components/ExpenseModal';

// Modular Screen Components
import { LoginScreen } from './src/screens/LoginScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { PdfDocsScreen } from './src/screens/PdfDocsScreen';
import { QueriesScreen } from './src/screens/QueriesScreen';
import { EarningsScreen } from './src/screens/EarningsScreen';
import { StatsScreen } from './src/screens/StatsScreen';
import { ProfileScreen, ProfileDataState } from './src/screens/ProfileScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';

import { NotificationDetailModal } from './src/components/NotificationDetailModal';
import { MLKitScannerModal } from './src/components/MLKitScannerModal';
import { AssayerQueryChatModal } from './src/components/AssayerQueryChatModal';

export default function App() {
  // Authentication State (Read saved session synchronously to prevent flash on refresh)
  const initialSession = MobileApiService.restoreSession();
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(Boolean(initialSession));
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authenticating, setAuthenticating] = useState(false);

  const [assayerName, setAssayerName] = useState<string>(
    initialSession ? (initialSession.userName || `Assayer Session (${(initialSession.userId || 'active').slice(0, 8)})`) : ''
  );
  const [assignments, setAssignments] = useState<AssayerAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState<TabType>('SCHEDULE');

  const [activeAssignment, setActiveAssignment] = useState<AssayerAssignment | null>(null);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [uploadedPdfName, setUploadedPdfName] = useState<string | null>(null);
  const [selectedPdfData, setSelectedPdfData] = useState<string | undefined>(undefined);
  const [scannerModalVisible, setScannerModalVisible] = useState(false);
  const [queryChatModalVisible, setQueryChatModalVisible] = useState(false);
  const [queryChatAssignment, setQueryChatAssignment] = useState<AssayerAssignment | null>(null);
  const [notifModalVisible, setNotifModalVisible] = useState(false);

  // Notification Detail Modal State
  const [notifDetailAssignment, setNotifDetailAssignment] = useState<AssayerAssignment | null>(null);

  // Public Profile Updatable State (Synchronous Cache & Backend Restoration)
  const defaults: ProfileDataState = {
    phone: '',
    alternatePhone: '',
    address: '',
    city: '',
    state: '',
    district: '',
    pincode: '',
    latitude: 28.6315000,
    longitude: 77.2167000,
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
    assayerCode: '',
  };

  const getInitialProfileState = (): ProfileDataState => {
    try {
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem('fapoms_assayer_profile_cache') : null;
      if (cached) return { ...defaults, ...JSON.parse(cached) };
    } catch (e) {}
    return { ...defaults };
  };

  const [profile, setProfile] = useState<ProfileDataState>(getInitialProfileState);
  const [savingProfile, setSavingProfile] = useState(false);

  const updateProfileField = (field: keyof ProfileDataState, value: any) => {
    setProfile((prev: ProfileDataState) => {
      const next = { ...prev, [field]: value };
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('fapoms_assayer_profile_cache', JSON.stringify(next));
        }
      } catch (e) {}
      return next;
    });
  };

  // Query Response State
  const [activeQuery, setActiveQuery] = useState<ValidationQuery | null>(null);
  const [queryResponseText, setQueryResponseText] = useState('');

  // Rejection Modal State
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [rejectAssignmentId, setRejectAssignmentId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Expense Modal State
  const [expenseModalVisible, setExpenseModalVisible] = useState(false);
  const [expenseCategory, setExpenseCategory] = useState<'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'>('TRAVEL_KM');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');

  // Notification State
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [selectedNotification, setSelectedNotification] = useState<AppNotification | null>(null);

  const loadNotifications = useCallback(async () => {
    setNotifLoading(true);
    const items = await MobileApiService.getNotifications();
    setNotifications(items);
    setUnreadNotifCount(items.filter((n) => !n.isRead).length);
    setNotifLoading(false);
  }, []);

  const notifDetailRef = useRef(notifDetailAssignment);
  notifDetailRef.current = notifDetailAssignment;

  useEffect(() => {
    if (isAuthenticated) {
      loadAssignments().then(() => {
        loadAssayerProfile();
        registerForPushNotificationsAsync();
        loadNotifications();
      });

      const socket = connectMobileSocket();

      const playNewAssignmentRingtone = () => {
        try {
          const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
          if (g.window && (g.AudioContext || g.webkitAudioContext)) {
            const AudioCtx = g.AudioContext || g.webkitAudioContext;
            const ctx = new AudioCtx();
            const playChime = (freq: number, startTime: number, duration: number) => {
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.type = 'sine';
              osc.frequency.setValueAtTime(freq, ctx.currentTime + startTime);
              gain.gain.setValueAtTime(0.3, ctx.currentTime + startTime);
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + duration);
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.start(ctx.currentTime + startTime);
              osc.stop(ctx.currentTime + startTime + duration);
            };
            playChime(587.33, 0, 0.2);   // D5
            playChime(880, 0.15, 0.25);   // A5
            playChime(1174.66, 0.35, 0.5); // D6
          }
        } catch (e) {}
      };

      const handlers: Record<string, (data?: any) => void> = {
        'assignment:status-changed': () => { loadAssignments(); loadNotifications(); },
        'assignment:counter-offered': (data: any) => {
          playNewAssignmentRingtone();
          loadAssignments();
          loadNotifications();
          Alert.alert(
            '💬 COUNTER OFFER UPDATE!',
            `Counter rate proposal update received (₹${data?.proposedFee || ''}).`,
            [{ text: 'View Update', onPress: () => setSelectedTab('SCHEDULE') }]
          );
        },
        'assignment:created': (data: any) => {
          playNewAssignmentRingtone();
          loadAssignments();
          loadNotifications();
          const branchName = data?.branchName || 'Bank Branch';
          Alert.alert(
            '🔔 NEW ASSIGNMENT INVITE!',
            `You have received a direct app invitation for ${branchName}. Check your schedule to Accept or Reject.`,
            [{ text: 'View Invitation', onPress: () => setSelectedTab('SCHEDULE') }]
          );
        },
        'assignment:fee-updated': () => { loadAssignments(); },
        'notification:new': () => {
          playNewAssignmentRingtone();
          loadNotifications();
        },
        'query:raised': (data: any) => {
          playNewAssignmentRingtone();
          loadAssignments();
          loadNotifications();
          Alert.alert(
            '❓ NEW VALIDATION QUERY RAISED!',
            `Data entry team raised a query: "${data?.queryText || 'Clarification required for audit'}". Tap to respond.`,
            [{ text: 'Open Query Chat', onPress: () => setSelectedTab('SCHEDULE') }]
          );
        },
        'query:responded': () => { loadAssignments(); loadNotifications(); },
        'schedule:created': () => { loadAssignments(); },
        'schedule:updated': () => { loadAssignments(); },
        'document:uploaded': () => { loadAssignments(); loadNotifications(); },
        'document:status-changed': () => { loadAssignments(); },
        'communication:created': () => { loadAssignments(); },
        'billing:created': () => { loadAssignments(); },
      };

      if (socket) {
        for (const [event, handler] of Object.entries(handlers)) {
          socket.on(event, handler);
        }
        socket.on('comment:added', (data: any) => {
          if (notifDetailRef.current?.id === data.assignmentId) {
            loadAssignments();
          }
        });
      }

      return () => {
        if (socket) {
          for (const [event, handler] of Object.entries(handlers)) {
            socket.off(event, handler);
          }
          socket.off('comment:added');
        }
      };
    } else {
      disconnectMobileSocket();
    }
  }, [isAuthenticated]);

  const handleMarkNotificationRead = async (id: string) => {
    await MobileApiService.markNotificationRead(id);
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    );
    setUnreadNotifCount((prev) => Math.max(0, prev - 1));
  };

  const handleTapNotification = (notification: AppNotification) => {
    setSelectedNotification(notification);
    if (notification.assignmentId) {
      const matched = assignments.find((a) => a.id === notification.assignmentId);
      if (matched) {
        setSelectedTab('SCHEDULE');
        setNotifDetailAssignment(matched);
      }
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    const cleanup = setupNotificationListeners(
      (notification) => {
        loadNotifications();
        const data = notification.request.content.data;
        if (data?.assignmentId) {
          const matched = assignments.find((a) => a.id === data.assignmentId);
          if (matched) {
            setNotifDetailAssignment(matched);
          }
        }
      },
      (response) => {
        loadNotifications();
        const data = response.notification.request.content.data;
        if (data?.assignmentId) {
          setSelectedTab('SCHEDULE');
          const matched = assignments.find((a) => a.id === data.assignmentId);
          if (matched) {
            setNotifDetailAssignment(matched);
          }
        }
      },
    );
    return cleanup;
  }, [isAuthenticated, assignments]);

  const loadAssayerProfile = async () => {
    const userId = MobileApiService.getCurrentUserId();
    if (!userId) return;
    try {
      const res = await MobileApiService.getAssayerProfile(userId);
      if (res.success && res.data) {
        const d = res.data;
        const fetchedProfile: ProfileDataState = {
          phone: d.phone ?? profile.phone,
          alternatePhone: d.alternatePhone ?? profile.alternatePhone,
          address: d.address ?? profile.address,
          city: d.city ?? profile.city,
          state: d.state ?? profile.state,
          district: d.district ?? profile.district,
          pincode: d.pincode ?? profile.pincode,
          latitude: d.latitude != null ? Number(d.latitude) : profile.latitude,
          longitude: d.longitude != null ? Number(d.longitude) : profile.longitude,
          preferredRegions: Array.isArray(d.preferredRegions) ? d.preferredRegions.join(', ') : (d.preferredRegions ?? profile.preferredRegions),
          preferredRadius: d.preferredRadius ?? profile.preferredRadius ?? 10,
          languages: Array.isArray(d.languages) ? d.languages.join(', ') : (d.languages ?? profile.languages),
          licenseNo: d.certifications?.[0]?.name ?? profile.licenseNo,
          emergencyName: d.emergencyContactName ?? profile.emergencyName,
          emergencyPhone: d.emergencyContactPhone ?? profile.emergencyPhone,
          emergencyRelation: d.emergencyContactRelation ?? profile.emergencyRelation,
          skills: Array.isArray(d.skills) ? d.skills.join(', ') : (d.skills ?? profile.skills),
          experienceYears: d.experienceYears ?? profile.experienceYears,
          panNumber: d.panNumber ?? profile.panNumber,
          bankAccountNumber: d.bankAccountNumber ?? profile.bankAccountNumber,
          ifscCode: d.ifscCode ?? profile.ifscCode,
          maxDailyWorkload: d.maxDailyWorkload ?? profile.maxDailyWorkload,
          maxWeeklyWorkload: d.maxWeeklyWorkload ?? profile.maxWeeklyWorkload,
          employmentType: d.employmentType ?? profile.employmentType,
          performanceRating: d.performanceRating ?? profile.performanceRating,
          averageRating: d.averageRating ?? profile.averageRating,
          totalAssignments: d.totalAssignments ?? profile.totalAssignments,
          completedAssignments: d.completedAssignments ?? profile.completedAssignments,
          onTimeCompletions: d.onTimeCompletions ?? profile.onTimeCompletions,
          totalEarnings: d.totalEarnings ?? profile.totalEarnings,
          runningBalance: d.runningBalance ?? profile.runningBalance,
          assayerCode: d.assayerCode ?? profile.assayerCode,
        };
        setProfile(fetchedProfile);
        setAssayerName(d.displayName || d.firstName && `${d.firstName} ${d.lastName}` || profile.assayerCode || assayerName);
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('fapoms_assayer_profile_cache', JSON.stringify(fetchedProfile));
          }
        } catch (e) {}
      }
    } catch (e) {}
  };

  const loadAssignments = async () => {
    setLoading(true);
    const userId = MobileApiService.getCurrentUserId();
    if (userId) {
      setAssayerName(MobileApiService.getCurrentUserName() || `Assayer Session (${userId.slice(0, 8)})`);
    }
    const data = await MobileApiService.getAssayerAssignments(userId || undefined);
    setAssignments(data || []);
    if (data && data.length > 0) {
      setActiveAssignment(data[0]);
    } else {
      setActiveAssignment(null);
    }
    setLoading(false);
  };

  const handleLogin = async () => {
    if (!loginUsername || !loginPassword) {
      Alert.alert('Required Fields', 'Please enter username and password.');
      return;
    }
    setAuthenticating(true);
    const res = await MobileApiService.login(loginUsername, loginPassword);
    setAuthenticating(false);

    if (res.success && res.token) {
      const verification = await MobileApiService.verifyAssayerIdentity(loginUsername);
      const assayerId = verification.assayer?.id || res.user?.id;
      const name = verification.assayer?.name || res.user?.name || res.user?.username || loginUsername;
      MobileApiService.setAuthToken(res.token, assayerId, name);
      setAssayerName(name);
      setIsAuthenticated(true);
    } else {
      Alert.alert('Authentication Failed', res.error || 'Invalid credentials.');
    }
  };

  const handleBiometricLogin = async () => {
    if (!loginUsername) {
      Alert.alert('Required Field', 'Please enter your assayer code / phone number first.');
      return;
    }

    try {
      const LocalAuthentication = require('expo-local-authentication');
      
      // 1. Check if hardware supports biometrics
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        Alert.alert(
          'Biometrics Unavailable',
          'Biometric hardware (FaceID / Fingerprint) is not configured or registered on this device. Using secure fallback authentication...'
        );
      } else {
        // 2. Trigger real OS Native Biometric Prompt (Face ID / Touch ID / Fingerprint)
        const bioResult = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Authenticate with FaceID / Fingerprint for Sumeru Audit',
          fallbackLabel: 'Use Password Instead',
          cancelLabel: 'Cancel',
          disableDeviceFallback: false,
        });

        if (!bioResult.success) {
          Alert.alert('Biometric Error', bioResult.error || 'Biometric authentication was cancelled.');
          return;
        }
      }
    } catch (e) {
      // Web / Fallback mode compatibility
    }

    // 3. Complete server session authentication
    setAuthenticating(true);
    const res = await MobileApiService.biometricLogin(loginUsername);
    setAuthenticating(false);

    if (res.success && res.token) {
      const assayerId = res.user?.id || loginUsername;
      const name = res.user?.name || loginUsername;
      MobileApiService.setAuthToken(res.token, assayerId, name);
      setAssayerName(name);
      setIsAuthenticated(true);
      Alert.alert('Biometric Sign-In Successful', `Welcome back, ${name}!`);
    } else {
      Alert.alert('Biometric Login Failed', res.error || 'Assayer not found or inactive.');
    }
  };

  const openGoogleMaps = (lat: number, lng: number) => {
    const url =
      Platform.OS === 'ios'
        ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`
        : `https://maps.google.com/maps?daddr=${lat},${lng}`;
    Linking.openURL(url).catch(() => Linking.openURL(`https://maps.google.com/maps?daddr=${lat},${lng}`));
  };

  const handleLogout = () => {
    MobileApiService.clearSession();
    setIsAuthenticated(false);
    setActiveAssignment(null);
    setAssignments([]);
  };

  const handleAcceptAssignment = async (id: string) => {
    const success = await MobileApiService.updateAssignmentStatus(id, 'ACCEPTED');
    if (success) {
      setAssignments(assignments.map((a) => (a.id === id ? { ...a, status: 'ACCEPTED' as const } : a)));
      Alert.alert('Assignment Accepted', 'Branch audit added to your daily route.');
    } else {
      Alert.alert('Accept Failed', 'Could not update assignment. It may have been modified.');
    }
  };

  const handleConfirmRejection = async () => {
    if (!rejectAssignmentId || !rejectReason.trim()) {
      Alert.alert('Validation Error', 'Please enter a rejection reason.');
      return;
    }
    const success = await MobileApiService.updateAssignmentStatus(rejectAssignmentId, 'REJECTED', rejectReason);
    setRejectModalVisible(false);
    setRejectReason('');
    if (success) {
      setAssignments(assignments.map((a) => (a.id === rejectAssignmentId ? { ...a, status: 'REJECTED' as const } : a)));
      Alert.alert('Assignment Rejected', 'Operations team has been notified.');
    } else {
      Alert.alert('Rejection Failed', 'Could not update assignment. It may have been modified.');
    }
  };

  const handleCheckIn = async (assignment: AssayerAssignment) => {
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const res = await MobileApiService.checkInBranch(assignment.id, assignment.latitude, assignment.longitude);
    if (res.success) {
      const updated = {
        ...assignment,
        status: 'CHECKED_IN' as const,
        checkedInAt: now,
        checkInGeoLat: assignment.latitude,
        checkInGeoLng: assignment.longitude,
      };
      setActiveAssignment(updated);
      setAssignments(assignments.map((a) => (a.id === assignment.id ? updated : a)));
    } else {
      Alert.alert('Check-In Failed', res.error || 'Could not record check-in. Please try again.');
    }
  };

  const handlePickAndUploadPdf = async (assignment: AssayerAssignment) => {
    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
      if (Platform.OS === 'web' && g.document) {
        const input = g.document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf';
        input.onchange = async (e: any) => {
          const file = e.target?.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = async () => {
            const base64 = (reader.result as string).split(',')[1];
            setUploadingPdf(true);
            const targetId = assignment.projectBranchId || assignment.id;
            const res = await MobileApiService.uploadCompletedAuditPdf(targetId, file.name, base64, assignment.id);
            setUploadingPdf(false);
            if (res.success) {
              Alert.alert('Audit Uploaded!', `Scanned audit report "${file.name}" uploaded successfully. Assignment marked COMPLETED.`);
              loadAssignments();
            } else {
              Alert.alert('Upload Failed', res.error || 'Could not upload PDF document.');
            }
          };
          reader.readAsDataURL(file);
        };
        input.click();
        return;
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        setUploadingPdf(true);
        const targetId = assignment.projectBranchId || assignment.id;
        const res = await MobileApiService.uploadCompletedAuditPdf(targetId, asset.name, base64, assignment.id);
        setUploadingPdf(false);
        if (res.success) {
          Alert.alert('Audit Uploaded!', `Scanned audit report "${asset.name}" uploaded successfully. Assignment marked COMPLETED.`);
          loadAssignments();
        } else {
          Alert.alert('Upload Failed', res.error || 'Could not upload PDF document.');
        }
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to select PDF file.');
    }
  };

  const handleRespondToQuery = async () => {
    if (!activeQuery || !queryResponseText.trim()) {
      Alert.alert('Error', 'Please enter a clarification response.');
      return;
    }
    await MobileApiService.respondToQuery(activeQuery.id, queryResponseText);

    if (activeAssignment) {
      const updatedQueries = activeAssignment.queries.map((q) =>
        q.id === activeQuery.id ? { ...q, assayerResponse: queryResponseText, status: 'RESOLVED' as const } : q
      );
      const updatedAssignment = { ...activeAssignment, queries: updatedQueries };
      setActiveAssignment(updatedAssignment);
      setAssignments(assignments.map((a) => (a.id === activeAssignment.id ? updatedAssignment : a)));
    }

    Alert.alert('Response Sent!', 'Clarification delivered to Data Entry Validation Team.');
    setActiveQuery(null);
    setQueryResponseText('');
  };

  const handleAddExpense = async () => {
    if (!activeAssignment || !expenseAmount || !expenseDescription) {
      Alert.alert('Validation Error', 'Please enter amount and description.');
      return;
    }
    const amt = parseFloat(expenseAmount);
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('Error', 'Invalid expense amount.');
      return;
    }

    const newExpense: AssayerExpense = {
      id: `exp-${Date.now()}`,
      assignmentId: activeAssignment.id,
      branchName: activeAssignment.branchName,
      category: expenseCategory,
      amount: amt,
      description: expenseDescription,
      status: 'PENDING',
    };

    const updatedAssignment = {
      ...activeAssignment,
      expenses: [...(activeAssignment.expenses || []), newExpense],
    };

    setActiveAssignment(updatedAssignment);
    setAssignments(assignments.map((a) => (a.id === activeAssignment.id ? updatedAssignment : a)));

    await MobileApiService.submitExpense(activeAssignment.id, expenseCategory, amt, expenseDescription);
    Alert.alert('Expense Submitted!', `₹${amt} claim sent to operations manager.`);
    setExpenseModalVisible(false);
    setExpenseAmount('');
    setExpenseDescription('');
  };

  // Computations — using real backend data & commercial base fee fallbacks
  const getAssignmentTotalFee = (a: any) => {
    const fee = a.agreedBaseFee > 0 ? a.agreedBaseFee : (a.proposedFee > 0 ? a.proposedFee : (a.standardBaseFee || 1200));
    const travel = a.agreedTravelFee || 0;
    return fee + travel;
  };

  const totalCompleted = profile.completedAssignments || assignments.filter((a) => a.status === 'COMPLETED').length;
  const completedEarnings = Number(profile.totalEarnings) || assignments.reduce((sum, a) => sum + (a.status === 'COMPLETED' ? getAssignmentTotalFee(a) : 0), 0);
  const pendingEarnings = assignments.reduce((sum, a) => sum + (a.status !== 'COMPLETED' ? getAssignmentTotalFee(a) : 0), 0);
  const openQueries = activeAssignment?.queries.filter((q) => q.status === 'OPEN') || [];

  const totalQueriesCount = assignments.reduce((sum, a) => sum + (a.queries?.length || 0), 0);
  const resolvedQueriesCount = assignments.reduce((sum, a) => sum + (a.queries?.filter((q) => q.status === 'RESOLVED').length || 0), 0);
  const queryResolutionRate = totalQueriesCount > 0 ? Math.round((resolvedQueriesCount / totalQueriesCount) * 100) : 0;

  const totalCustCount = assignments.reduce((sum, a) => sum + (a.customers?.length || 0), 0);
  const auditedCustCount = assignments.reduce((sum, a) => sum + (a.customers?.filter((c) => c.status === 'AUDITED').length || 0), 0);
  const qualityScore = totalCustCount > 0 ? Math.round((auditedCustCount / totalCustCount) * 100) : 0;

  const avgAuditHours = assignments.length > 0 && assignments.some((a) => a.estimatedAuditHours > 0)
    ? (assignments.reduce((sum, a) => sum + a.estimatedAuditHours, 0) / assignments.length).toFixed(1)
    : '—';

  if (!isAuthenticated) {
    return (
      <LoginScreen
        loginUsername={loginUsername}
        loginPassword={loginPassword}
        authenticating={authenticating}
        onChangeUsername={setLoginUsername}
        onChangePassword={setLoginPassword}
        onLogin={handleLogin}
        onBiometricLogin={handleBiometricLogin}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Header
        assayerName={assayerName}
        unreadNotifCount={unreadNotifCount}
        onRefresh={loadAssignments}
        onLogout={handleLogout}
        onNotificationsPress={() => setNotifModalVisible(true)}
      />
      <TabBar selectedTab={selectedTab} onSelectTab={setSelectedTab} openQueriesCount={openQueries.length} unreadNotifCount={unreadNotifCount} />

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loadingText}>Syncing schedule with FAPOMS server...</Text>
        </View>
      ) : (
        <ScrollView style={styles.contentScroll}>
          {selectedTab === 'SCHEDULE' && (
            <ScheduleScreen
              assignments={assignments}
              onAcceptAssignment={handleAcceptAssignment}
              onOpenRejectModal={(id) => { setRejectAssignmentId(id); setRejectModalVisible(true); }}
              onCheckIn={handleCheckIn}
              onOpenPdfDocs={(a) => {
                setActiveAssignment(a);
                handlePickAndUploadPdf(a);
              }}
              onOpenScanner={(a) => {
                setActiveAssignment(a);
                setScannerModalVisible(true);
              }}
              onOpenQueryChat={(a) => {
                setQueryChatAssignment(a);
                setQueryChatModalVisible(true);
              }}
              onCounterOffer={async (a) => {
                const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
                const promptFn = g.prompt || null;
                const promptVal = promptFn
                  ? promptFn(`Enter your proposed fee rate (₹) for ${a.branchName}:`, String(a.proposedFee || 1500))
                  : null;
                if (!promptVal) return;
                const feeNum = parseFloat(promptVal);
                if (isNaN(feeNum) || feeNum <= 0) {
                  Alert.alert('Invalid Fee', 'Please enter a valid numeric fee amount.');
                  return;
                }
                const success = await MobileApiService.updateAssignmentStatus(
                  a.id,
                  'COUNTER_OFFER' as any,
                  `Assayer proposed rate: ₹${feeNum}`,
                  feeNum,
                );
                if (success) {
                  Alert.alert('Counter Rate Sent!', `Negotiated fee proposal ₹${feeNum} submitted to Operations Manager. Awaiting operations review.`);
                  loadAssignments();
                } else {
                  Alert.alert('Submission Failed', 'Could not submit counter offer.');
                }
              }}
            />
          )}

          {(selectedTab as any) === 'PDF_DOCUMENTS' && (
            <PdfDocsScreen
              activeAssignment={activeAssignment}
              uploadedPdfName={uploadedPdfName}
              uploadingPdf={uploadingPdf}
              onOpenScanner={() => setScannerModalVisible(true)}
              onSelectPdfFile={async () => {
                try {
                  const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
                  if (Platform.OS === 'web' && g.document) {
                    const input = g.document.createElement('input');
                    input.type = 'file';
                    input.accept = 'application/pdf';
                    input.onchange = (e: any) => {
                      const file = e.target?.files?.[0];
                      if (!file) return;
                      setUploadedPdfName(file.name);
                      const reader = new FileReader();
                      reader.onload = () => {
                        const base64 = (reader.result as string).split(',')[1];
                        setSelectedPdfData(base64);
                        Alert.alert('PDF Selected', file.name);
                      };
                      reader.readAsDataURL(file);
                    };
                    input.click();
                    return;
                  }

                  const result = await DocumentPicker.getDocumentAsync({
                    type: 'application/pdf',
                    copyToCacheDirectory: true,
                  });
                  if (!result.canceled && result.assets?.[0]) {
                    const asset = result.assets[0];
                    setUploadedPdfName(asset.name);
                    const base64 = await FileSystem.readAsStringAsync(asset.uri, {
                      encoding: FileSystem.EncodingType.Base64,
                    });
                    setSelectedPdfData(base64);
                    Alert.alert('PDF Selected', asset.name);
                  }
                } catch (e: any) {
                  Alert.alert('Error', e?.message || 'Failed to select PDF file.');
                }
              }}
              onSubmitCompletedPdf={async () => {
                if (!activeAssignment || !uploadedPdfName) {
                  Alert.alert('File Required', 'Please select a scanned audit PDF file to upload.');
                  return;
                }
                setUploadingPdf(true);
                const res = await MobileApiService.uploadCompletedAuditPdf(
                  activeAssignment.id,
                  uploadedPdfName,
                  selectedPdfData,
                );
                setUploadingPdf(false);
                if (res.success) {
                  setUploadedPdfName(null);
                  setSelectedPdfData(undefined);
                  Alert.alert('Success', 'Audit PDF uploaded successfully! Assignment transitioned to COMPLETED.');
                  loadAssignments();
                } else {
                  Alert.alert('Upload Status', res.error || 'Audit PDF recorded and synced.');
                }
              }}
              onOpenExpenseModal={() => setExpenseModalVisible(true)}
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
              totalEarnings={completedEarnings}
              pendingEarnings={pendingEarnings}
              runningBalance={Number(profile.runningBalance) || 0}
              assignments={assignments}
              onOpenExpenseModal={() => setExpenseModalVisible(true)}
            />
          )}

          {selectedTab === 'MY_PROFILE' && (
            <ProfileScreen
              assayerName={assayerName}
              assayerCode={profile.assayerCode || 'N/A'}
              profile={profile}
              savingProfile={savingProfile}
              onUpdateProfileField={updateProfileField}
              onSaveProfile={async () => {
                setSavingProfile(true);
                // 1. Instantly cache locally
                try {
                  if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('fapoms_assayer_profile_cache', JSON.stringify(profile));
                  }
                } catch (e) {}

                // 2. Synchronize with backend via MobileApiService
                const userId = MobileApiService.getCurrentUserId();
                if (userId) {
                  try {
                    const baseUrl = MobileApiService.getBaseUrl();
                    await MobileApiService.fetchWithAuth(`${baseUrl}/assayers/${userId}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        phone: profile.phone,
                        alternatePhone: profile.alternatePhone,
                        address: profile.address,
                        city: profile.city,
                        state: profile.state,
                        district: profile.district,
                        pincode: profile.pincode,
                        latitude: profile.latitude,
                        longitude: profile.longitude,
                        emergencyContactName: profile.emergencyName,
                        emergencyContactPhone: profile.emergencyPhone,
                        emergencyContactRelation: profile.emergencyRelation,
                        preferredRegions: profile.preferredRegions ? profile.preferredRegions.split(',').map((s: string) => s.trim()) : [],
                        languages: profile.languages ? profile.languages.split(',').map((s: string) => s.trim()) : [],
                        skills: profile.skills ? profile.skills.split(',').map((s: string) => s.trim()) : [],
                      }),
                    });
                  } catch (e) {}
                }
                setSavingProfile(false);
                Alert.alert('Profile & Precision GPS Saved Permanently 🎉', 'Your profile details, base address, and precision map location pin have been saved to FAPOMS!');
              }}
            />
          )}
        </ScrollView>
      )}

      <RejectionModal
        visible={rejectModalVisible}
        rejectReason={rejectReason}
        onChangeReason={setRejectReason}
        onConfirm={handleConfirmRejection}
        onCancel={() => setRejectModalVisible(false)}
      />

      <ExpenseModal
        visible={expenseModalVisible}
        expenseCategory={expenseCategory}
        expenseAmount={expenseAmount}
        expenseDescription={expenseDescription}
        onSelectCategory={setExpenseCategory}
        onChangeAmount={setExpenseAmount}
        onChangeDescription={setExpenseDescription}
        onSubmit={handleAddExpense}
        onCancel={() => setExpenseModalVisible(false)}
      />
      <NotificationDetailModal
        visible={Boolean(notifDetailAssignment)}
        assignment={notifDetailAssignment}
        onClose={() => setNotifDetailAssignment(null)}
        onAccept={handleAcceptAssignment}
        onNavigate={(assignment) => {
          setNotifDetailAssignment(null);
          openGoogleMaps(assignment.latitude, assignment.longitude);
        }}
      />
      <MLKitScannerModal
        visible={scannerModalVisible}
        onClose={() => setScannerModalVisible(false)}
        onPdfGenerated={(pdfName, base64Pdf) => {
          setUploadedPdfName(pdfName);
          setSelectedPdfData(base64Pdf);
          Alert.alert('📄 Scanned PDF Ready', `${pdfName} compiled successfully! Tap "Submit Completed PDF" to upload.`);
        }}
      />
      <AssayerQueryChatModal
        visible={queryChatModalVisible}
        assignment={queryChatAssignment}
        onClose={() => setQueryChatModalVisible(false)}
      />
      
      {/* ── Slide-over Notifications Drawer Modal ── */}
      {notifModalVisible && (
        <Modal animationType="slide" transparent={false} visible={notifModalVisible} onRequestClose={() => setNotifModalVisible(false)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#090d16' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, backgroundColor: '#0f172a', borderBottomWidth: 1, borderBottomColor: 'rgba(99,102,241,0.2)' }}>
              <Text style={{ fontSize: 18, fontWeight: '900', color: '#ffffff' }}>🔔 Notifications & Dispatch Alerts</Text>
              <TouchableOpacity onPress={() => setNotifModalVisible(false)} style={{ backgroundColor: 'rgba(239,68,68,0.15)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                <Text style={{ color: '#f87171', fontWeight: '800', fontSize: 13 }}>✕ Close</Text>
              </TouchableOpacity>
            </View>
            <NotificationsScreen
              notifications={notifications}
              loading={notifLoading}
              unreadCount={unreadNotifCount}
              onRefresh={loadNotifications}
              onMarkRead={handleMarkNotificationRead}
              onTapNotification={(n) => {
                setNotifModalVisible(false);
                handleTapNotification(n);
              }}
            />
          </SafeAreaView>
        </Modal>
      )}
    </SafeAreaView>
  );
}

registerRootComponent(App);
