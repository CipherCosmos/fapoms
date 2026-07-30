import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, Platform, Switch, Alert } from 'react-native';
import { styles } from '../theme/styles';
import { InteractiveMap } from '../components/InteractiveMap';
import { Ionicons as IoniconsRaw } from '@expo/vector-icons';
const Ionicons = IoniconsRaw as any;

export interface ProfileDataState {
  phone: string;
  alternatePhone: string;
  address: string;
  city: string;
  state: string;
  district: string;
  pincode: string;
  latitude: number;
  longitude: number;
  preferredRegions: string;
  preferredRadius: number;
  languages: string;
  licenseNo: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  skills: string;
  experienceYears: number;
  panNumber: string;
  bankAccountNumber: string;
  ifscCode: string;
  maxDailyWorkload: number;
  maxWeeklyWorkload: number;
  employmentType: string;
  performanceRating: number | string;
  averageRating: number;
  totalAssignments: number;
  completedAssignments: number;
  onTimeCompletions: number;
  totalEarnings: number | string;
  runningBalance: number | string;
  assayerCode: string;
  biometricsEnabled?: boolean;
  pinCode?: string;
  offlineSyncEnabled?: boolean;
  pushNotificationsEnabled?: boolean;
  soundAlertsEnabled?: boolean;
  appTheme?: 'DARK' | 'LIGHT' | 'SYSTEM';
}

interface ProfileScreenProps {
  assayerName?: string;
  assayerCode?: string;
  profile: ProfileDataState;
  savingProfile: boolean;
  onUpdateProfileField: (field: keyof ProfileDataState, value: any) => void;
  onSaveProfile: () => void;
  onLogout?: () => void;
}

export const ProfileScreen: React.FC<ProfileScreenProps> = ({
  assayerName = '',
  assayerCode = '',
  profile,
  savingProfile,
  onUpdateProfileField,
  onSaveProfile,
  onLogout,
}) => {
  const [activeCategory, setActiveCategory] = useState<'ACCOUNT' | 'SECURITY' | 'LOCATION' | 'WORKLOAD' | 'PREFERENCES' | 'SUPPORT'>('ACCOUNT');
  const [capturingGps, setCapturingGps] = useState<boolean>(false);
  const [gpsStatus, setGpsStatus] = useState<string>('GPS LOCKED 🛰️ (Precision ±5m)');

  const handleCaptureGps = () => {
    setCapturingGps(true);
    setGpsStatus('Acquiring high-precision satellite fix...');
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;

    const processPosition = async (lat: number, lon: number, accuracy: number) => {
      onUpdateProfileField('latitude', lat);
      onUpdateProfileField('longitude', lon);
      setGpsStatus(`GPS LOCKED 🛰️ (Precision ±${Math.round(accuracy)}m)`);

      try {
        const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
        const geoData = await geoRes.json().catch(() => ({}));
        if (geoData && geoData.address) {
          const addr = geoData.display_name || `${geoData.address.road || ''}, ${geoData.address.suburb || geoData.address.neighbourhood || ''}`;
          if (addr && addr.length > 5) onUpdateProfileField('address', addr);
          if (geoData.address.city || geoData.address.town || geoData.address.state_district) {
            onUpdateProfileField('city', geoData.address.city || geoData.address.town || geoData.address.state_district);
          }
          if (geoData.address.postcode) {
            onUpdateProfileField('pincode', geoData.address.postcode);
          }
        }
      } catch (e) {}

      setCapturingGps(false);
      setTimeout(() => {
        onSaveProfile();
      }, 300);
    };

    if (nav && nav.geolocation) {
      nav.geolocation.getCurrentPosition(
        (pos: any) => {
          const lat = parseFloat(pos.coords.latitude.toFixed(7));
          const lon = parseFloat(pos.coords.longitude.toFixed(7));
          processPosition(lat, lon, pos.coords.accuracy || 5);
        },
        (_err: any) => {
          setCapturingGps(false);
          setGpsStatus('GPS acquisition timed out. Please check location permissions.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 3000 }
      );
    } else {
      setCapturingGps(false);
      setGpsStatus('Geolocation not supported on this device.');
    }
  };

  const categories = [
    { key: 'ACCOUNT', label: 'Account & Identity', icon: 'person-outline' as const },
    { key: 'SECURITY', label: 'Security & Auth', icon: 'shield-checkmark-outline' as const },
    { key: 'LOCATION', label: 'Location & Radius', icon: 'location-outline' as const },
    { key: 'WORKLOAD', label: 'Audit & Workload', icon: 'briefcase-outline' as const },
    { key: 'PREFERENCES', label: 'App Preferences', icon: 'options-outline' as const },
    { key: 'SUPPORT', label: 'Help & Support', icon: 'help-circle-outline' as const },
  ];

  return (
    <ScrollView style={styles.contentScroll} showsVerticalScrollIndicator={false}>
      {/* ── User Header Card ── */}
      <View style={[styles.card, { padding: 16, backgroundColor: 'rgba(30,41,59,0.95)', borderColor: 'rgba(99,102,241,0.25)', marginBottom: 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: '#4f46e5',
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 2,
            borderColor: 'rgba(255,255,255,0.2)',
          }}>
            <Text style={{ fontSize: 24, fontWeight: '900', color: '#ffffff' }}>
              {(assayerName || 'A').charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: '#ffffff' }}>{assayerName || 'Authorized Assayer'}</Text>
              <View style={{ backgroundColor: 'rgba(16,185,129,0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' }}>
                <Text style={{ fontSize: 10, color: '#34d399', fontWeight: '800' }}>VERIFIED</Text>
              </View>
            </View>
            <Text style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
              Code: <Text style={{ color: '#38bdf8', fontWeight: '700' }}>{assayerCode || profile.assayerCode || 'N/A'}</Text> • BIS Certified
            </Text>
          </View>
        </View>
      </View>

      {/* ── Settings Category Selection Menu ── */}
      <Text style={{ fontSize: 12, fontWeight: '800', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10, marginLeft: 2 }}>
        Settings & Configuration
      </Text>

      <View style={{ gap: 8, marginBottom: 16 }}>
        {categories.map((cat) => {
          const isActive = activeCategory === cat.key;
          return (
            <TouchableOpacity
              key={cat.key}
              onPress={() => setActiveCategory(cat.key as any)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 14,
                backgroundColor: isActive ? 'rgba(99, 102, 241, 0.15)' : 'rgba(30, 41, 59, 0.7)',
                borderRadius: 14,
                borderWidth: 1,
                borderColor: isActive ? '#6366f1' : 'rgba(255, 255, 255, 0.08)',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: isActive ? '#4f46e5' : 'rgba(15, 23, 42, 0.6)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Ionicons name={cat.icon} size={18} color={isActive ? '#ffffff' : '#a5b4fc'} />
                </View>
                <Text style={{ fontSize: 14, fontWeight: '700', color: isActive ? '#ffffff' : '#cbd5e1' }}>
                  {cat.label}
                </Text>
              </View>
              <Ionicons name={isActive ? 'chevron-down' : 'chevron-forward'} size={18} color={isActive ? '#818cf8' : '#64748b'} />
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Settings Content Card ── */}
      <View style={[styles.card, { padding: 18, backgroundColor: 'rgba(30, 41, 59, 0.9)', borderColor: 'rgba(99, 102, 241, 0.2)', marginBottom: 24 }]}>
        {/* 1. ACCOUNT & IDENTITY */}
        {activeCategory === 'ACCOUNT' && (
          <View>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#ffffff', marginBottom: 4 }}>Account & Personal Identity</Text>
            <Text style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>Manage your contact numbers and official credentials.</Text>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Mobile Phone Number:</Text>
              <TextInput style={styles.textInput} value={profile.phone} onChangeText={(val) => onUpdateProfileField('phone', val)} keyboardType="phone-pad" />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Alternate Phone Number:</Text>
              <TextInput style={styles.textInput} value={profile.alternatePhone} onChangeText={(val) => onUpdateProfileField('alternatePhone', val)} keyboardType="phone-pad" />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>BIS Hallmark License Number:</Text>
              <TextInput style={styles.textInput} value={profile.licenseNo} onChangeText={(val) => onUpdateProfileField('licenseNo', val)} />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Languages Spoken:</Text>
              <TextInput style={styles.textInput} value={profile.languages} onChangeText={(val) => onUpdateProfileField('languages', val)} />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>PAN Card (Verified):</Text>
              <TextInput style={[styles.textInput, { color: '#94a3b8' }]} value={profile.panNumber ? `${profile.panNumber} (Verified ✅)` : 'NOT REGISTERED'} editable={false} />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Bank Account (Verified):</Text>
              <TextInput style={[styles.textInput, { color: '#94a3b8' }]} value={profile.bankAccountNumber ? `XXXX-XXXX-${profile.bankAccountNumber.slice(-4)}` : 'NOT REGISTERED'} editable={false} />
            </View>
          </View>
        )}

        {/* 2. SECURITY & AUTHENTICATION */}
        {activeCategory === 'SECURITY' && (
          <View>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#ffffff', marginBottom: 4 }}>Security & Quick Login</Text>
            <Text style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>Configure biometric hardware and 4-digit passcode authentication.</Text>

            {/* Biometrics Switch */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.6)', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 14 }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#ffffff' }}>Face ID / Fingerprint Auth</Text>
                <Text style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Allow rapid sign-in via device biometric hardware</Text>
              </View>
              <Switch
                value={profile.biometricsEnabled !== false}
                onValueChange={(val) => onUpdateProfileField('biometricsEnabled', val)}
                trackColor={{ false: '#475569', true: '#4f46e5' }}
                thumbColor={profile.biometricsEnabled !== false ? '#38bdf8' : '#cbd5e1'}
              />
            </View>

            {/* Quick 4-Digit PIN */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>4-Digit Quick Passcode / PIN:</Text>
              <TextInput
                style={styles.textInput}
                value={profile.pinCode || ''}
                onChangeText={(val) => onUpdateProfileField('pinCode', val.slice(0, 4))}
                placeholder="Set 4-Digit Security PIN (e.g. 1234)"
                placeholderTextColor="#475569"
                keyboardType="numeric"
                secureTextEntry
              />
            </View>
          </View>
        )}

        {/* 3. LOCATION & RADIUS */}
        {activeCategory === 'LOCATION' && (
          <View>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#ffffff', marginBottom: 4 }}>Base Location & Service Radius</Text>
            <Text style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>Set your registered base address and preferred audit distance.</Text>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Base City & District:</Text>
              <TextInput style={styles.textInput} value={profile.city} onChangeText={(val) => onUpdateProfileField('city', val)} />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Registered Street Address:</Text>
              <TextInput style={styles.textInput} value={profile.address} onChangeText={(val) => onUpdateProfileField('address', val)} multiline />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Postal Pincode:</Text>
              <TextInput style={styles.textInput} value={profile.pincode} onChangeText={(val) => onUpdateProfileField('pincode', val)} keyboardType="number-pad" />
            </View>

            {/* Service Radius Selector */}
            <View style={{ marginTop: 12, backgroundColor: 'rgba(15,23,42,0.6)', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
              <Text style={{ fontSize: 11, color: '#94a3b8', fontWeight: '800', marginBottom: 8 }}>PREFERRED SERVICE RADIUS</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <TouchableOpacity
                  onPress={() => onUpdateProfileField('preferredRadius', Math.max(1, (profile.preferredRadius || 10) - 5))}
                  style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '800' }}>−</Text>
                </TouchableOpacity>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: '#38bdf8' }}>{profile.preferredRadius || 10}</Text>
                  <Text style={{ fontSize: 10, color: '#64748b' }}>kilometers</Text>
                </View>
                <TouchableOpacity
                  onPress={() => onUpdateProfileField('preferredRadius', Math.min(100, (profile.preferredRadius || 10) + 5))}
                  style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '800' }}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Map Preview */}
            <View style={{ marginTop: 14, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: '#0f172a' }}>
              {Platform.OS === 'web' ? (
                <InteractiveMap
                  latitude={profile.latitude || 28.6315}
                  longitude={profile.longitude || 77.2167}
                  radiusKm={profile.preferredRadius || 10}
                  onLocationChange={(lat, lng) => {
                    onUpdateProfileField('latitude', lat);
                    onUpdateProfileField('longitude', lng);
                  }}
                  onRadiusChange={(km) => onUpdateProfileField('preferredRadius', km)}
                />
              ) : (
                <View style={{ height: 160, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#94a3b8', fontSize: 12 }}>Map rendering enabled for Web & Native</Text>
                </View>
              )}
            </View>

            <TouchableOpacity
              onPress={handleCaptureGps}
              disabled={capturingGps}
              style={{
                marginTop: 14, backgroundColor: '#4f46e5', paddingVertical: 12, borderRadius: 10,
                alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
              }}
            >
              {capturingGps ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={{ color: '#ffffff', fontWeight: '800', fontSize: 13 }}>📍 Auto-Detect GPS Satellite Fix</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* 4. WORKLOAD & CAPACITY */}
        {activeCategory === 'WORKLOAD' && (
          <View>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#ffffff', marginBottom: 4 }}>Audit & Operational Capacity</Text>
            <Text style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>Configured daily and weekly workload limits set by Sumeru Operations.</Text>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Max Daily Audit Limit:</Text>
              <TextInput style={[styles.textInput, { color: '#94a3b8' }]} value={`${profile.maxDailyWorkload || 0} Audits / Day`} editable={false} />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Max Weekly Audit Limit:</Text>
              <TextInput style={[styles.textInput, { color: '#94a3b8' }]} value={`${profile.maxWeeklyWorkload || 0} Audits / Week`} editable={false} />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Assayer Employment Type:</Text>
              <TextInput style={[styles.textInput, { color: '#94a3b8' }]} value={profile.employmentType || 'CONTRACTOR'} editable={false} />
            </View>
          </View>
        )}

        {/* 5. APP PREFERENCES */}
        {activeCategory === 'PREFERENCES' && (
          <View>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#ffffff', marginBottom: 4 }}>Application Preferences</Text>
            <Text style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>Customize app behavior, notifications, and offline data sync.</Text>

            {/* Offline Data Sync */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.6)', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 12 }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#ffffff' }}>Offline Audit Caching</Text>
                <Text style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Auto-save audit reports locally when offline</Text>
              </View>
              <Switch
                value={profile.offlineSyncEnabled !== false}
                onValueChange={(val) => onUpdateProfileField('offlineSyncEnabled', val)}
                trackColor={{ false: '#475569', true: '#4f46e5' }}
                thumbColor={profile.offlineSyncEnabled !== false ? '#38bdf8' : '#cbd5e1'}
              />
            </View>

            {/* Push Notifications */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.6)', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 12 }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#ffffff' }}>Dispatch Push Notifications</Text>
                <Text style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Receive instant alerts for new audit invites</Text>
              </View>
              <Switch
                value={profile.pushNotificationsEnabled !== false}
                onValueChange={(val) => onUpdateProfileField('pushNotificationsEnabled', val)}
                trackColor={{ false: '#475569', true: '#4f46e5' }}
                thumbColor={profile.pushNotificationsEnabled !== false ? '#38bdf8' : '#cbd5e1'}
              />
            </View>

            {/* Audio Alerts */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.6)', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#ffffff' }}>Sound & Chime Alerts</Text>
                <Text style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Play audio chime when new dispatch is assigned</Text>
              </View>
              <Switch
                value={profile.soundAlertsEnabled !== false}
                onValueChange={(val) => onUpdateProfileField('soundAlertsEnabled', val)}
                trackColor={{ false: '#475569', true: '#4f46e5' }}
                thumbColor={profile.soundAlertsEnabled !== false ? '#38bdf8' : '#cbd5e1'}
              />
            </View>
          </View>
        )}

        {/* 6. HELP & SUPPORT */}
        {activeCategory === 'SUPPORT' && (
          <View>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#ffffff', marginBottom: 4 }}>Sumeru Support & Emergency</Text>
            <Text style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>Direct hotline to Sumeru Operations & Control Center.</Text>

            <TouchableOpacity
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                backgroundColor: 'rgba(15,23,42,0.6)', padding: 14, borderRadius: 12,
                borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 10,
              }}
              onPress={() => Alert.alert('Support Helpline', 'Contacting Sumeru Operations Helpline: +91 1800-123-4567')}
            >
              <Ionicons name="call-outline" size={20} color="#38bdf8" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#ffffff' }}>Operations Control Desk</Text>
                <Text style={{ fontSize: 11, color: '#94a3b8' }}>Toll-free 24/7 Helpline: 1800-123-4567</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                backgroundColor: 'rgba(15,23,42,0.6)', padding: 14, borderRadius: 12,
                borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 10,
              }}
              onPress={() => Alert.alert('App Information', 'Sumeru Global Audit & Support Suite v2.4.0 (Build 2026.07)')}
            >
              <Ionicons name="information-circle-outline" size={20} color="#a5b4fc" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#ffffff' }}>App Build & Version</Text>
                <Text style={{ fontSize: 11, color: '#94a3b8' }}>v2.4.0 • Enterprise Production Engine</Text>
              </View>
            </TouchableOpacity>

            {onLogout && (
              <TouchableOpacity
                style={{
                  marginTop: 10, backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.3)',
                  alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
                }}
                onPress={onLogout}
              >
                <Ionicons name="log-out-outline" size={18} color="#f87171" />
                <Text style={{ color: '#f87171', fontWeight: '800', fontSize: 14 }}>Sign Out of App Session</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Save Settings Action Button ── */}
        <TouchableOpacity
          style={[styles.saveBtn, { marginTop: 22, backgroundColor: '#4f46e5', paddingVertical: 14, borderRadius: 12 }]}
          disabled={savingProfile}
          onPress={onSaveProfile}
        >
          {savingProfile ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={[styles.btnTextWhite, { fontSize: 14, fontWeight: '800', letterSpacing: 0.3 }]}>
              💾 Save Settings Permanently
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
};
