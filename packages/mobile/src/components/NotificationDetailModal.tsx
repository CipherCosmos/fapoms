import React from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, Platform } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { Ionicons } from '@expo/vector-icons';

interface NotificationDetailModalProps {
  visible: boolean;
  onClose: () => void;
  assignment: AssayerAssignment | null;
  onAccept?: (assignmentId: string) => void;
  onNavigate?: (assignment: AssayerAssignment) => void;
}

export const NotificationDetailModal: React.FC<NotificationDetailModalProps> = ({
  visible,
  onClose,
  assignment,
  onAccept,
  onNavigate,
}) => {
  if (!visible || !assignment) return null;

  const mapPreviewHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <style>body { margin: 0; padding: 0; background: #0f172a; } #map { width: 100vw; height: 100vh; }</style>
    </head>
    <body>
      <div id="map"></div>
      <script>
        var lat = ${assignment.latitude || 18.5204};
        var lng = ${assignment.longitude || 73.8567};
        var map = L.map('map', { zoomControl: false }).setView([lat, lng], 14);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
        L.marker([lat, lng]).addTo(map).bindPopup('<b>${(assignment.branchName || 'Branch Location').replace(/'/g, "\\'")}</b>').openPopup();
      </script>
    </body>
    </html>
  `;

  return (
    <Modal visible={visible} animationType="fade" transparent={true} onRequestClose={onClose}>
      <View style={overlay}>
        <View style={modalCard}>
          <View style={headerRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#6366f1' }} />
              <Text style={badgeText}>ASSIGNMENT DETAILS</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={18} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flexGrow: 0, marginBottom: 16 }}>
            <Text style={title}>{assignment.branchName}</Text>
            <Text style={subTitle}>Code: {assignment.branchCode || 'BR-0010'}</Text>
            <Text style={address}>{assignment.branchAddress}</Text>

            {Platform.OS === 'web' ? (
              <View style={mapPreviewContainer}>
                <iframe
                  srcDoc={mapPreviewHtml}
                  style={{ width: '100%', height: '100%', border: 'none', borderRadius: 12 }}
                  title="Branch Preview Map"
                />
              </View>
            ) : (
              <View style={[mapPreviewContainer, { alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: '#38bdf8', fontSize: 16, fontWeight: '700' }}>{assignment.branchName}</Text>
                <Text style={{ color: '#94a3b8', fontSize: 12, marginTop: 2 }}>{assignment.branchAddress}</Text>
              </View>
            )}

            <View style={detailsGrid}>
              <View style={detailBox}>
                <Text style={detailLabel}>Date</Text>
                <Text style={detailValue}>{assignment.scheduledDate || 'Today'}</Text>
              </View>
              <View style={detailBox}>
                <Text style={detailLabel}>Fee</Text>
                <Text style={detailValue}>
                  {assignment.agreedBaseFee > 0
                    ? `₹${assignment.agreedBaseFee}`
                    : assignment.proposedFee > 0
                    ? `₹${assignment.proposedFee} (Proposed)`
                    : 'Pending'}
                  {assignment.agreedTravelFee > 0 ? ` + ₹${assignment.agreedTravelFee}` : ''}
                </Text>
              </View>
              {assignment.estimatedAuditHours > 0 && (
                <View style={detailBox}>
                  <Text style={detailLabel}>Duration</Text>
                  <Text style={detailValue}>{assignment.estimatedAuditHours}h</Text>
                </View>
              )}
              <View style={detailBox}>
                <Text style={detailLabel}>Status</Text>
                <Text style={detailValue}>{assignment.status}</Text>
              </View>
            </View>
          </ScrollView>

          <View style={footerRow}>
            {assignment.status === 'PENDING' && onAccept && (
              <TouchableOpacity
                style={[btn, acceptBtn]}
                onPress={() => { onAccept(assignment.id); onClose(); }}
              >
                <Text style={btnText}>Accept</Text>
              </TouchableOpacity>
            )}
            {onNavigate && (
              <TouchableOpacity
                style={[btn, navBtn]}
                onPress={() => { onClose(); onNavigate(assignment); }}
              >
                <Text style={btnText}>Navigate</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
};

const overlay = {
  flex: 1,
  backgroundColor: 'rgba(9, 13, 22, 0.9)',
  justifyContent: 'center',
  alignItems: 'center',
  padding: 16,
} as any;

const modalCard = {
  width: '100%',
  maxWidth: 500,
  maxHeight: '85%',
  backgroundColor: 'rgba(30, 41, 59, 0.95)',
  borderRadius: 22,
  padding: 20,
  borderWidth: 1,
  borderColor: 'rgba(99, 102, 241, 0.25)',
  ...Platform.select({ web: { backdropFilter: 'blur(16px)' } as any }),
} as any;

const headerRow = {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
} as any;

const badgeText = {
  color: '#a5b4fc',
  fontWeight: '800',
  fontSize: 11,
  letterSpacing: 0.5,
} as any;

const title = {
  color: '#f8fafc',
  fontSize: 20,
  fontWeight: '700',
} as any;

const subTitle = {
  color: '#94a3b8',
  fontSize: 12,
  marginTop: 2,
} as any;

const address = {
  color: '#cbd5e1',
  fontSize: 13,
  marginTop: 8,
  lineHeight: 18,
} as any;

const mapPreviewContainer = {
  height: 160,
  borderRadius: 14,
  overflow: 'hidden',
  marginTop: 14,
  marginBottom: 14,
  borderWidth: 1,
  borderColor: 'rgba(99, 102, 241, 0.2)',
  backgroundColor: '#0f172a',
} as any;

const detailsGrid = {
  flexDirection: 'row',
  flexWrap: 'wrap',
  gap: 8,
} as any;

const detailBox = {
  flex: 1,
  minWidth: '45%',
  backgroundColor: 'rgba(15, 23, 42, 0.6)',
  borderRadius: 12,
  padding: 12,
  borderWidth: 1,
  borderColor: 'rgba(255, 255, 255, 0.05)',
} as any;

const detailLabel = {
  color: '#94a3b8',
  fontSize: 11,
  fontWeight: '600',
} as any;

const detailValue = {
  color: '#38bdf8',
  fontSize: 15,
  fontWeight: '700',
  marginTop: 2,
} as any;

const footerRow = {
  flexDirection: 'row',
  gap: 10,
} as any;

const btn = {
  flex: 1,
  paddingVertical: 14,
  borderRadius: 12,
  alignItems: 'center',
  justifyContent: 'center',
} as any;

const acceptBtn = {
  backgroundColor: '#10b981',
} as any;

const navBtn = {
  backgroundColor: '#6366f1',
} as any;

const btnText = {
  color: '#ffffff',
  fontWeight: '700',
  fontSize: 14,
} as any;
