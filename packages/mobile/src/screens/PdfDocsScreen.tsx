import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, Linking, ActivityIndicator, Alert } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { styles } from '../theme/styles';
import { Ionicons } from '@expo/vector-icons';

interface PdfDocsScreenProps {
  activeAssignment: AssayerAssignment | null;
  uploadedPdfName: string | null;
  uploadingPdf: boolean;
  onSelectPdfFile: () => void;
  onOpenScanner?: () => void;
  onSubmitCompletedPdf: () => void;
  onOpenExpenseModal: () => void;
}

export const PdfDocsScreen: React.FC<PdfDocsScreenProps> = ({
  activeAssignment,
  uploadedPdfName,
  uploadingPdf,
  onSelectPdfFile,
  onOpenScanner,
  onSubmitCompletedPdf,
  onOpenExpenseModal,
}) => {
  const [branchDocuments, setBranchDocuments] = useState<any[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  const branchId = activeAssignment?.projectBranchId;

  const loadDocuments = useCallback(async () => {
    if (!branchId) return;
    setLoadingDocs(true);
    const res = await MobileApiService.getBranchDocuments(branchId);
    setBranchDocuments(res.success && res.data ? res.data : []);
    setLoadingDocs(false);
  }, [branchId]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  if (!activeAssignment) return null;

  return (
    <View>
      <Text style={styles.sectionHeading}>Branch Audit Documents: {activeAssignment.branchName}</Text>

      {/* SECTION 1: DOWNLOAD ASSIGNED BRANCH PDF */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>1. Download Assigned Branch Audit PDF</Text>
        <Text style={styles.branchSubText}>
          Download the generated customer audit PDF document sent by the operations team for this branch.
        </Text>

        {loadingDocs && <ActivityIndicator color="#6366f1" style={{ marginBottom: 10 }} />}

        {/* Explicit empty state. The list used to silently render nothing here, which was
            indistinguishable from "still loading" — and previously the backend papered over it
            by fabricating a placeholder PDF on read, so this case never appeared at all. */}
        {!loadingDocs && branchDocuments.length === 0 && (
          <View style={{ paddingVertical: 14, alignItems: 'center' }}>
            <Ionicons name="document-outline" size={22} color="#64748b" />
            <Text style={{ color: '#94a3b8', fontSize: 12, marginTop: 6, textAlign: 'center' }}>
              No audit paperwork has been dispatched for this branch yet.
            </Text>
            <Text style={{ color: '#64748b', fontSize: 11, marginTop: 2, textAlign: 'center' }}>
              You'll be notified as soon as operations sends it.
            </Text>
          </View>
        )}

        {branchDocuments.length > 0 && (
          <View style={{ marginBottom: 12 }}>
            {branchDocuments.map((doc: any) => (
              <TouchableOpacity
                key={doc.id}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#334155' }}
                onPress={async () => {
                  // Downloads are no longer an open URL — the endpoint requires a short-lived
                  // token scoped to this document, so fetch one with our session first.
                  const url = await MobileApiService.getDocumentDownloadUrl(doc.id);
                  if (!url) {
                    Alert.alert(
                      'Download unavailable',
                      'Could not authorise this download. Please check your connection and try again.',
                    );
                    return;
                  }
                  Linking.openURL(url);
                }}
              >
                <Text style={{ fontSize: 14, color: '#818cf8', fontWeight: '600', flex: 1 }}>{doc.fileName || doc.documentType || 'Document'}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="download" size={11} color="#94a3b8" />
                  <Text style={{ fontSize: 11, color: '#94a3b8' }}>Download</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Was `Linking.openURL()` onto the documents *API* endpoint, which opened raw JSON in
            the browser rather than any document — and now returns 401, since that endpoint is
            no longer public. The documents are already listed above, so the useful action here
            is refreshing that list. */}
        <TouchableOpacity style={styles.saveBtn} onPress={loadDocuments} disabled={loadingDocs}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="refresh" size={14} color="#fff" />
            <Text style={styles.btnTextWhite}>
              {loadingDocs ? 'Checking for documents…' : 'Check for New Documents'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* SECTION 2: UPLOAD COMPLETED SCANNED PDF */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>2. Upload Completed & Signed Audit PDF</Text>
        <Text style={styles.branchSubText}>
          After completing the physical gold assay audit at the branch, scan or capture the completed PDF report with signatures and upload it here to complete your assignment.
        </Text>

        {uploadedPdfName && (
          <View style={{ backgroundColor: 'rgba(16,185,129,0.15)', padding: 12, borderRadius: 8, marginBottom: 14, borderWidth: 1, borderColor: '#10b981' }}>
            <Text style={{ color: '#34d399', fontWeight: '700', fontSize: 13 }}>Selected / Scanned File: {uploadedPdfName}</Text>
          </View>
        )}

        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
          <TouchableOpacity style={[styles.mapBtn, { flex: 1, backgroundColor: '#6366f1' }]} onPress={onOpenScanner || onSelectPdfFile}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="camera" size={14} color="#fff" />
            <Text style={styles.btnTextWhite}>Camera Scan Pages</Text>
          </View>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.mapBtn, { flex: 1, backgroundColor: '#334155' }]} onPress={onSelectPdfFile}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="folder" size={14} color="#fff" />
            <Text style={styles.btnTextWhite}>Pick PDF File</Text>
          </View>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.checkInBtn, { marginTop: 14, backgroundColor: uploadedPdfName ? '#10b981' : '#475569' }]}
          disabled={uploadingPdf}
          onPress={onSubmitCompletedPdf}
        >
          {uploadingPdf ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="checkmark-circle" size={14} color="#fff" />
            <Text style={styles.btnTextWhite}>Submit Completed PDF & Finalize Audit</Text>
          </View>
          )}
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.addExpBtn} onPress={onOpenExpenseModal}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="add" size={14} color="#0f172a" />
        <Text style={styles.btnTextDark}>Add Travel / Additional Expense</Text>
      </View>
      </TouchableOpacity>
    </View>
  );
};
