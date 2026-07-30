import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Linking, ActivityIndicator } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { styles } from '../theme/styles';

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

  useEffect(() => {
    if (activeAssignment?.projectBranchId) {
      setLoadingDocs(true);
      MobileApiService.getBranchDocuments(activeAssignment.projectBranchId).then((res) => {
        if (res.success && res.data) {
          setBranchDocuments(res.data);
        }
        setLoadingDocs(false);
      });
    }
  }, [activeAssignment?.projectBranchId]);

  if (!activeAssignment) return null;

  const branchDocUrl = `${MobileApiService.getBaseUrl()}/documents/project-branch/${activeAssignment.projectBranchId}`;

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

        {branchDocuments.length > 0 && (
          <View style={{ marginBottom: 12 }}>
            {branchDocuments.map((doc: any) => (
              <TouchableOpacity
                key={doc.id}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#334155' }}
                onPress={() => {
                  const url = doc.downloadUrl || `${MobileApiService.getBaseUrl()}/documents/${doc.id}/download`;
                  Linking.openURL(url);
                }}
              >
                <Text style={{ fontSize: 14, color: '#818cf8', fontWeight: '600', flex: 1 }}>{doc.fileName || doc.documentType || 'Document'}</Text>
                <Text style={{ fontSize: 11, color: '#94a3b8' }}>⬇ Download</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={styles.saveBtn}
          onPress={() => Linking.openURL(branchDocUrl)}
        >
          <Text style={styles.btnTextWhite}>📄 View All Branch Documents</Text>
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
            <Text style={styles.btnTextWhite}>📸 Camera Scan Pages</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.mapBtn, { flex: 1, backgroundColor: '#334155' }]} onPress={onSelectPdfFile}>
            <Text style={styles.btnTextWhite}>📁 Pick PDF File</Text>
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
            <Text style={styles.btnTextWhite}>✅ Submit Completed PDF & Finalize Audit</Text>
          )}
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.addExpBtn} onPress={onOpenExpenseModal}>
        <Text style={styles.btnTextDark}>➕ Add Travel / Additional Expense</Text>
      </TouchableOpacity>
    </View>
  );
};
