import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  ActivityIndicator,
  Linking,
  TextInput,
  Modal,
} from 'react-native';
import { AssayerAssignment, CustomerRecord, ValidationQuery, AssayerExpense } from './src/types/mobile-app';
import { MobileApiService } from './src/services/api.service';

export default function App() {
  const [assayerName] = useState('Rahul Sharma (Assayer)');
  const [assignments, setAssignments] = useState<AssayerAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState<'SCHEDULE' | 'DIGITAL_FORM' | 'QUERIES' | 'EARNINGS' | 'PERFORMANCE'>('SCHEDULE');

  // Selected assignment for active audit form
  const [activeAssignment, setActiveAssignment] = useState<AssayerAssignment | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRecord | null>(null);

  // Form input states
  const [auditedGrossWeight, setAuditedGrossWeight] = useState('');
  const [auditedNetWeight, setAuditedNetWeight] = useState('');
  const [purityKarat, setPurityKarat] = useState('22');
  const [sealIntact, setSealIntact] = useState(true);
  const [auditRemarks, setAuditRemarks] = useState('');

  // Query Response State
  const [activeQuery, setActiveQuery] = useState<ValidationQuery | null>(null);
  const [queryResponseText, setQueryResponseText] = useState('');

  // Expense Modal State
  const [expenseModalVisible, setExpenseModalVisible] = useState(false);
  const [expenseCategory, setExpenseCategory] = useState<'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'>('TRAVEL_KM');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');

  useEffect(() => {
    loadAssignments();
  }, []);

  const loadAssignments = async () => {
    setLoading(true);
    const data = await MobileApiService.getAssayerAssignments('assayer-001');
    setAssignments(data);
    if (data.length > 0) {
      setActiveAssignment(data[0]);
    }
    setLoading(false);
  };

  const handleAcceptAssignment = async (id: string) => {
    const updated = assignments.map((a) => (a.id === id ? { ...a, status: 'ACCEPTED' as const } : a));
    setAssignments(updated);
    await MobileApiService.updateAssignmentStatus(id, 'ACCEPTED');
    Alert.alert('Assignment Accepted', 'Branch schedule confirmed. Office team notified.');
  };

  const handleRejectAssignment = async (id: string) => {
    Alert.prompt('Reject Assignment', 'Please enter reason for rejection:', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        onPress: async (reason) => {
          const updated = assignments.map((a) => (a.id === id ? { ...a, status: 'REJECTED' as const } : a));
          setAssignments(updated);
          await MobileApiService.updateAssignmentStatus(id, 'REJECTED', reason);
          Alert.alert('Rejected', 'Assignment rejection updated for operations team.');
        },
      },
    ]);
  };

  const handleBranchCheckIn = async (assignment: AssayerAssignment) => {
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const updated = assignments.map((a) =>
      a.id === assignment.id ? { ...a, status: 'CHECKED_IN' as const, checkedInAt: now } : a
    );
    setAssignments(updated);
    if (activeAssignment?.id === assignment.id) {
      setActiveAssignment({ ...activeAssignment, status: 'CHECKED_IN', checkedInAt: now });
    }
    await MobileApiService.checkInBranch(assignment.id, assignment.latitude, assignment.longitude);
    Alert.alert('Checked-In Successfully!', `GPS check-in recorded at ${now}. Branch manager notified.`);
  };

  const handleOpenCustomerForm = (customer: CustomerRecord) => {
    setSelectedCustomer(customer);
    setAuditedGrossWeight(customer.auditedGrossWeightGrams?.toString() || customer.pledgedGrossWeightGrams.toString());
    setAuditedNetWeight(customer.auditedNetWeightGrams?.toString() || customer.pledgedNetWeightGrams.toString());
    setPurityKarat(customer.purityKarat?.toString() || '22');
    setSealIntact(customer.sealIntact ?? true);
    setAuditRemarks(customer.remarks || '');
    setSelectedTab('DIGITAL_FORM');
  };

  const handleSaveCustomerAudit = async () => {
    if (!activeAssignment || !selectedCustomer) return;

    const gross = parseFloat(auditedGrossWeight);
    const net = parseFloat(auditedNetWeight);
    const purity = parseInt(purityKarat, 10);

    if (isNaN(gross) || isNaN(net)) {
      Alert.alert('Validation Error', 'Please enter valid numbers for Gross and Net weight.');
      return;
    }

    const updatedCustomers = activeAssignment.customers.map((c) =>
      c.id === selectedCustomer.id
        ? {
            ...c,
            auditedGrossWeightGrams: gross,
            auditedNetWeightGrams: net,
            purityKarat: purity,
            sealIntact,
            remarks: auditRemarks,
            status: 'AUDITED' as const,
          }
        : c
    );

    const updatedAssignment = { ...activeAssignment, customers: updatedCustomers, status: 'IN_PROGRESS' as const };
    setActiveAssignment(updatedAssignment);
    setAssignments(assignments.map((a) => (a.id === activeAssignment.id ? updatedAssignment : a)));

    await MobileApiService.saveCustomerAudit(
      activeAssignment.id,
      selectedCustomer.id,
      gross,
      net,
      purity,
      sealIntact,
      auditRemarks
    );

    Alert.alert('Saved!', `Audit entry for ${selectedCustomer.customerName} saved locally and synced.`);
    setSelectedCustomer(null);
  };

  const handleRespondToQuery = async () => {
    if (!activeQuery || !queryResponseText.trim()) {
      Alert.alert('Error', 'Please enter a clarification response.');
      return;
    }

    await MobileApiService.respondToQuery(activeQuery.id, queryResponseText);

    if (activeAssignment) {
      const updatedQueries = activeAssignment.queries.map((q) =>
        q.id === activeQuery.id
          ? { ...q, assayerResponse: queryResponseText, status: 'RESOLVED' as const }
          : q
      );
      const updated = { ...activeAssignment, queries: updatedQueries };
      setActiveAssignment(updated);
      setAssignments(assignments.map((a) => (a.id === activeAssignment.id ? updated : a)));
    }

    Alert.alert('Response Sent!', 'Clarification sent directly to Nitin & Data Entry Validator.');
    setActiveQuery(null);
    setQueryResponseText('');
  };

  const handleAddExpense = async () => {
    if (!activeAssignment || !expenseAmount || isNaN(parseFloat(expenseAmount))) {
      Alert.alert('Error', 'Please enter a valid expense amount.');
      return;
    }

    const newExp: AssayerExpense = {
      id: `exp-${Date.now()}`,
      assignmentId: activeAssignment.id,
      branchName: activeAssignment.branchName,
      category: expenseCategory,
      amount: parseFloat(expenseAmount),
      description: expenseDescription,
      status: 'PENDING',
    };

    const updated = { ...activeAssignment, expenses: [...activeAssignment.expenses, newExp] };
    setActiveAssignment(updated);
    setAssignments(assignments.map((a) => (a.id === activeAssignment.id ? updated : a)));

    await MobileApiService.submitExpense(activeAssignment.id, expenseCategory, parseFloat(expenseAmount), expenseDescription);

    Alert.alert('Expense Submitted', 'Expense sent for office approval.');
    setExpenseModalVisible(false);
    setExpenseAmount('');
    setExpenseDescription('');
  };

  const handleFinalSubmitAudit = async (assignment: AssayerAssignment) => {
    const unAudited = assignment.customers.filter((c) => c.status === 'PENDING');
    if (unAudited.length > 0) {
      Alert.alert(
        'Incomplete Audit',
        `There are ${unAudited.length} customer records pending audit in this branch.`
      );
      return;
    }

    const updated = { ...assignment, status: 'COMPLETED' as const };
    setActiveAssignment(updated);
    setAssignments(assignments.map((a) => (a.id === assignment.id ? updated : a)));

    await MobileApiService.updateAssignmentStatus(assignment.id, 'COMPLETED');
    Alert.alert('🎉 Audit Submitted Successfully!', 'Branch audit marked as complete. System status updated for Client & Data Entry team.');
  };

  const handleOpenMap = (lat: number, lng: number) => {
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
  };

  // Compute metrics
  const totalCompleted = assignments.filter((a) => a.status === 'COMPLETED').length;
  const totalEarnings = assignments.reduce((sum, a) => sum + (a.status === 'COMPLETED' ? a.agreedBaseFee + a.agreedTravelFee : 0), 0);
  const pendingEarnings = assignments.reduce((sum, a) => sum + (a.status !== 'COMPLETED' ? a.agreedBaseFee + a.agreedTravelFee : 0), 0);
  const openQueries = activeAssignment?.queries.filter((q) => q.status === 'OPEN') || [];

  return (
    <SafeAreaView style={styles.container}>
      {/* App Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.appTitle}>FAPOMS Assayer Mobile</Text>
          <Text style={styles.assayerSubtitle}>{assayerName}</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={loadAssignments}>
          <Text style={styles.refreshBtnText}>🔄 Refresh</Text>
        </TouchableOpacity>
      </View>

      {/* Main Navigation Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity style={[styles.tabItem, selectedTab === 'SCHEDULE' && styles.activeTabItem]} onPress={() => setSelectedTab('SCHEDULE')}>
          <Text style={[styles.tabLabel, selectedTab === 'SCHEDULE' && styles.activeTabLabel]}>📅 Schedule</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabItem, selectedTab === 'DIGITAL_FORM' && styles.activeTabItem]} onPress={() => setSelectedTab('DIGITAL_FORM')}>
          <Text style={[styles.tabLabel, selectedTab === 'DIGITAL_FORM' && styles.activeTabLabel]}>📝 Audit Form</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabItem, selectedTab === 'QUERIES' && styles.activeTabItem]} onPress={() => setSelectedTab('QUERIES')}>
          <Text style={[styles.tabLabel, selectedTab === 'QUERIES' && styles.activeTabLabel]}>
            💬 Queries {openQueries.length > 0 ? `(${openQueries.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabItem, selectedTab === 'EARNINGS' && styles.activeTabItem]} onPress={() => setSelectedTab('EARNINGS')}>
          <Text style={[styles.tabLabel, selectedTab === 'EARNINGS' && styles.activeTabLabel]}>💰 Earnings</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabItem, selectedTab === 'PERFORMANCE' && styles.activeTabItem]} onPress={() => setSelectedTab('PERFORMANCE')}>
          <Text style={[styles.tabLabel, selectedTab === 'PERFORMANCE' && styles.activeTabLabel]}>📊 Stats</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loadingText}>Syncing schedule with FAPOMS server...</Text>
        </View>
      ) : (
        <ScrollView style={styles.contentScroll}>
          {/* TAB 1: DAILY SCHEDULE */}
          {selectedTab === 'SCHEDULE' && (
            <View>
              <Text style={styles.sectionHeading}>Today's Recommended Sequence</Text>
              {assignments.map((assignment, index) => (
                <View key={assignment.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={styles.seqBadge}>
                      <Text style={styles.seqText}>Stop #{index + 1}</Text>
                    </View>
                    <Text style={[styles.statusBadge, styles[`status_${assignment.status}` as keyof typeof styles]]}>
                      {assignment.status}
                    </Text>
                  </View>

                  <Text style={styles.branchName}>{assignment.branchName}</Text>
                  <Text style={styles.address}>📍 {assignment.branchAddress}</Text>

                  <View style={styles.metricsRow}>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Customers</Text>
                      <Text style={styles.metricVal}>{assignment.estimatedCustomerCount}</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Audit Duration</Text>
                      <Text style={styles.metricVal}>{assignment.estimatedAuditHours} hrs</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Fee + Travel</Text>
                      <Text style={styles.metricVal}>₹{assignment.agreedBaseFee + assignment.agreedTravelFee}</Text>
                    </View>
                  </View>

                  {/* Actions per status */}
                  {assignment.status === 'PENDING' && (
                    <View style={styles.actionGrid}>
                      <TouchableOpacity style={styles.acceptBtn} onPress={() => handleAcceptAssignment(assignment.id)}>
                        <Text style={styles.btnTextWhite}>✓ Accept Assignment</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.rejectBtn} onPress={() => handleRejectAssignment(assignment.id)}>
                        <Text style={styles.btnTextWhite}>✕ Reject</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {assignment.status === 'ACCEPTED' && (
                    <View style={styles.actionGrid}>
                      <TouchableOpacity style={styles.mapBtn} onPress={() => handleOpenMap(assignment.latitude, assignment.longitude)}>
                        <Text style={styles.btnTextDark}>🗺️ Route Navigation</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.checkInBtn} onPress={() => handleBranchCheckIn(assignment)}>
                        <Text style={styles.btnTextWhite}>📍 Branch Check-in</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {(assignment.status === 'CHECKED_IN' || assignment.status === 'IN_PROGRESS') && (
                    <View style={styles.actionGrid}>
                      <TouchableOpacity
                        style={styles.primaryBtn}
                        onPress={() => {
                          setActiveAssignment(assignment);
                          setSelectedTab('DIGITAL_FORM');
                        }}
                      >
                        <Text style={styles.btnTextWhite}>📝 Open Digital Audit Form</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.submitFinalBtn} onPress={() => handleFinalSubmitAudit(assignment)}>
                        <Text style={styles.btnTextWhite}>✅ Submit Audit</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}

          {/* TAB 2: DIGITAL AUDIT FORM */}
          {selectedTab === 'DIGITAL_FORM' && activeAssignment && (
            <View>
              <Text style={styles.sectionHeading}>Digital Audit Form: {activeAssignment.branchName}</Text>

              {selectedCustomer ? (
                /* Customer Detail Form */
                <View style={styles.card}>
                  <TouchableOpacity style={styles.backBtn} onPress={() => setSelectedCustomer(null)}>
                    <Text style={styles.backBtnText}>← Back to Customer List</Text>
                  </TouchableOpacity>

                  <Text style={styles.customerFormTitle}>Customer: {selectedCustomer.customerName}</Text>
                  <Text style={styles.customerSub}>Account: {selectedCustomer.accountNumber} | Packet: {selectedCustomer.pledgedPacketNo}</Text>
                  <Text style={styles.customerPledged}>Pledged Item: {selectedCustomer.pledgedItemDescription}</Text>

                  <View style={styles.inputGroup}>
                    <Text style={styles.inputLabel}>Audited Gross Weight (Grams):</Text>
                    <TextInput
                      style={styles.textInput}
                      keyboardType="decimal-pad"
                      value={auditedGrossWeight}
                      onChangeText={setAuditedGrossWeight}
                    />
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.inputLabel}>Audited Net Weight (Grams):</Text>
                    <TextInput
                      style={styles.textInput}
                      keyboardType="decimal-pad"
                      value={auditedNetWeight}
                      onChangeText={setAuditedNetWeight}
                    />
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.inputLabel}>Purity (Karat):</Text>
                    <TextInput
                      style={styles.textInput}
                      keyboardType="number-pad"
                      value={purityKarat}
                      onChangeText={setPurityKarat}
                    />
                  </View>

                  <View style={styles.switchRow}>
                    <Text style={styles.inputLabel}>Vault Packet Seal Intact?</Text>
                    <TouchableOpacity
                      style={[styles.toggleBtn, sealIntact ? styles.toggleOn : styles.toggleOff]}
                      onPress={() => setSealIntact(!sealIntact)}
                    >
                      <Text style={styles.btnTextWhite}>{sealIntact ? 'YES (Intact)' : 'NO (Damaged)'}</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.inputLabel}>Audit Remarks / Observations:</Text>
                    <TextInput
                      style={[styles.textInput, { height: 60 }]}
                      multiline
                      value={auditRemarks}
                      onChangeText={setAuditRemarks}
                    />
                  </View>

                  <TouchableOpacity style={styles.saveBtn} onPress={handleSaveCustomerAudit}>
                    <Text style={styles.btnTextWhite}>💾 Save & Sync Customer Audit</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                /* Customer List View */
                <View>
                  {activeAssignment.customers.map((c, idx) => (
                    <TouchableOpacity key={c.id} style={styles.customerRow} onPress={() => handleOpenCustomerForm(c)}>
                      <View style={styles.customerRowLeft}>
                        <Text style={styles.customerIndex}>#{idx + 1}</Text>
                        <View>
                          <Text style={styles.customerNameText}>{c.customerName}</Text>
                          <Text style={styles.accountText}>{c.accountNumber} ({c.pledgedPacketNo})</Text>
                        </View>
                      </View>
                      <Text style={[styles.custStatusBadge, c.status === 'AUDITED' ? styles.custAudited : styles.custPending]}>
                        {c.status}
                      </Text>
                    </TouchableOpacity>
                  ))}

                  <TouchableOpacity style={styles.addExpBtn} onPress={() => setExpenseModalVisible(true)}>
                    <Text style={styles.btnTextDark}>➕ Add Travel / Additional Expense</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* TAB 3: VALIDATION QUERIES */}
          {selectedTab === 'QUERIES' && activeAssignment && (
            <View>
              <Text style={styles.sectionHeading}>Data Entry & Validation Queries</Text>
              {activeAssignment.queries.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>No open queries from Nitin or validation team.</Text>
                </View>
              ) : (
                activeAssignment.queries.map((q) => (
                  <View key={q.id} style={styles.card}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.queryValidator}>{q.validatorName}</Text>
                      <Text style={styles.queryStatus}>{q.status}</Text>
                    </View>
                    <Text style={styles.queryCust}>Customer: {q.customerName} ({q.accountNumber})</Text>
                    <Text style={styles.queryBody}>❓ {q.queryText}</Text>

                    {q.assayerResponse ? (
                      <View style={styles.responseBox}>
                        <Text style={styles.responseTextTitle}>Your Response:</Text>
                        <Text style={styles.responseText}>{q.assayerResponse}</Text>
                      </View>
                    ) : (
                      <View>
                        <TextInput
                          style={styles.textInput}
                          placeholder="Type clarification for data entry team..."
                          value={activeQuery?.id === q.id ? queryResponseText : ''}
                          onChangeText={(text) => {
                            setActiveQuery(q);
                            setQueryResponseText(text);
                          }}
                        />
                        <TouchableOpacity style={styles.respondBtn} onPress={handleRespondToQuery}>
                          <Text style={styles.btnTextWhite}>💬 Send Response</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ))
              )}
            </View>
          )}

          {/* TAB 4: EARNINGS DASHBOARD */}
          {selectedTab === 'EARNINGS' && (
            <View>
              <Text style={styles.sectionHeading}>Earnings & Payment Ledger</Text>
              <View style={styles.earningsSummaryGrid}>
                <View style={styles.earningsCard}>
                  <Text style={styles.earningsLabel}>Completed Earnings</Text>
                  <Text style={styles.earningsVal}>₹{totalEarnings}</Text>
                </View>
                <View style={styles.earningsCard}>
                  <Text style={styles.earningsLabel}>Pending Payouts</Text>
                  <Text style={styles.earningsVal}>₹{pendingEarnings}</Text>
                </View>
              </View>

              <Text style={styles.subHeading}>Submitted Expenses</Text>
              {activeAssignment?.expenses.map((exp) => (
                <View key={exp.id} style={styles.expenseRow}>
                  <View>
                    <Text style={styles.expDesc}>{exp.category} - {exp.description}</Text>
                    <Text style={styles.expBranch}>{exp.branchName}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.expAmount}>₹{exp.amount}</Text>
                    <Text style={styles.expStatus}>{exp.status}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* TAB 5: PERFORMANCE DASHBOARD */}
          {selectedTab === 'PERFORMANCE' && (
            <View>
              <Text style={styles.sectionHeading}>Assayer Performance Metrics</Text>
              <View style={styles.perfGrid}>
                <View style={styles.perfBox}>
                  <Text style={styles.perfVal}>98.5%</Text>
                  <Text style={styles.perfLabel}>Quality Score</Text>
                </View>
                <View style={styles.perfBox}>
                  <Text style={styles.perfVal}>{totalCompleted}</Text>
                  <Text style={styles.perfLabel}>Audits Completed</Text>
                </View>
                <View style={styles.perfBox}>
                  <Text style={styles.perfVal}>100%</Text>
                  <Text style={styles.perfLabel}>Query Resolution Rate</Text>
                </View>
                <View style={styles.perfBox}>
                  <Text style={styles.perfVal}>3.8 hrs</Text>
                  <Text style={styles.perfLabel}>Avg Completion Time</Text>
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* Expense Modal */}
      <Modal visible={expenseModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Submit Audit Expense</Text>
            <Text style={styles.inputLabel}>Category:</Text>
            <View style={styles.actionGrid}>
              {(['TRAVEL_KM', 'TOLL', 'FOOD', 'OTHER'] as const).map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.catBtn, expenseCategory === cat && styles.catBtnActive]}
                  onPress={() => setExpenseCategory(cat)}
                >
                  <Text style={expenseCategory === cat ? styles.btnTextWhite : styles.btnTextDark}>{cat}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.inputLabel}>Amount (₹):</Text>
            <TextInput style={styles.textInput} keyboardType="number-pad" value={expenseAmount} onChangeText={setExpenseAmount} />

            <Text style={styles.inputLabel}>Description:</Text>
            <TextInput style={styles.textInput} value={expenseDescription} onChangeText={setExpenseDescription} />

            <View style={styles.actionGrid}>
              <TouchableOpacity style={styles.saveBtn} onPress={handleAddExpense}>
                <Text style={styles.btnTextWhite}>Submit Expense</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.rejectBtn} onPress={() => setExpenseModalVisible(false)}>
                <Text style={styles.btnTextWhite}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#0f172a' },
  appTitle: { fontSize: 18, fontWeight: '700', color: '#ffffff' },
  assayerSubtitle: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  refreshBtn: { backgroundColor: '#1e293b', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  refreshBtnText: { color: '#e2e8f0', fontSize: 12, fontWeight: '600' },
  tabBar: { flexDirection: 'row', backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  tabItem: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  activeTabItem: { borderBottomWidth: 3, borderBottomColor: '#2563eb' },
  tabLabel: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  activeTabLabel: { color: '#2563eb' },
  contentScroll: { paddingHorizontal: 16, paddingTop: 12 },
  sectionHeading: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 12 },
  subHeading: { fontSize: 14, fontWeight: '700', color: '#334155', marginTop: 16, marginBottom: 8 },
  card: { backgroundColor: '#ffffff', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#e2e8f0' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  seqBadge: { backgroundColor: '#e0e7ff', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  seqText: { fontSize: 11, fontWeight: '700', color: '#4338ca' },
  statusBadge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, overflow: 'hidden' },
  status_PENDING: { backgroundColor: '#fef3c7', color: '#b45309' },
  status_ACCEPTED: { backgroundColor: '#dbeafe', color: '#1e40af' },
  status_CHECKED_IN: { backgroundColor: '#fef08a', color: '#854d0e' },
  status_IN_PROGRESS: { backgroundColor: '#e0e7ff', color: '#4338ca' },
  status_COMPLETED: { backgroundColor: '#dcfce7', color: '#15803d' },
  status_REJECTED: { backgroundColor: '#fee2e2', color: '#b91c1c' },
  branchName: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  address: { fontSize: 13, color: '#334155', marginTop: 6 },
  metricsRow: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#f8fafc', padding: 10, borderRadius: 8, marginTop: 12 },
  metricBox: { alignItems: 'center' },
  metricLabel: { fontSize: 11, color: '#64748b' },
  metricVal: { fontSize: 14, fontWeight: '700', color: '#0f172a', marginTop: 2 },
  actionGrid: { flexDirection: 'row', gap: 8, marginTop: 12 },
  acceptBtn: { flex: 1, backgroundColor: '#16a34a', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  rejectBtn: { backgroundColor: '#ef4444', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  mapBtn: { flex: 1, backgroundColor: '#e2e8f0', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  checkInBtn: { flex: 1, backgroundColor: '#d97706', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  primaryBtn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  submitFinalBtn: { backgroundColor: '#059669', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  btnTextWhite: { color: '#ffffff', fontWeight: '700', fontSize: 13 },
  btnTextDark: { color: '#0f172a', fontWeight: '700', fontSize: 13 },
  customerFormTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  customerSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  customerPledged: { fontSize: 13, color: '#1e40af', marginTop: 4, fontWeight: '600' },
  inputGroup: { marginTop: 12 },
  inputLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4 },
  textInput: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, backgroundColor: '#ffffff' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  toggleBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6 },
  toggleOn: { backgroundColor: '#16a34a' },
  toggleOff: { backgroundColor: '#dc2626' },
  saveBtn: { backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginTop: 16 },
  backBtn: { marginBottom: 12 },
  backBtnText: { color: '#2563eb', fontSize: 13, fontWeight: '600' },
  customerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#ffffff', padding: 14, borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  customerRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  customerIndex: { fontSize: 14, fontWeight: '700', color: '#94a3b8' },
  customerNameText: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  accountText: { fontSize: 12, color: '#64748b' },
  custStatusBadge: { fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, overflow: 'hidden' },
  custAudited: { backgroundColor: '#dcfce7', color: '#15803d' },
  custPending: { backgroundColor: '#fef3c7', color: '#b45309' },
  addExpBtn: { backgroundColor: '#e2e8f0', paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginTop: 16 },
  emptyBox: { padding: 24, alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 12 },
  emptyText: { color: '#94a3b8', fontSize: 13 },
  queryValidator: { fontSize: 13, fontWeight: '700', color: '#4338ca' },
  queryStatus: { fontSize: 11, fontWeight: '700', color: '#b45309' },
  queryCust: { fontSize: 12, fontWeight: '600', color: '#0f172a', marginTop: 4 },
  queryBody: { fontSize: 13, color: '#1e293b', marginTop: 6, backgroundColor: '#fef3c7', padding: 10, borderRadius: 6 },
  responseBox: { marginTop: 10, backgroundColor: '#f0fdf4', padding: 10, borderRadius: 6 },
  responseTextTitle: { fontSize: 11, fontWeight: '700', color: '#15803d' },
  responseText: { fontSize: 12, color: '#166534', marginTop: 2 },
  respondBtn: { backgroundColor: '#4338ca', paddingVertical: 10, borderRadius: 8, alignItems: 'center', marginTop: 8 },
  earningsSummaryGrid: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  earningsCard: { flex: 1, backgroundColor: '#ffffff', padding: 16, borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', alignItems: 'center' },
  earningsLabel: { fontSize: 12, color: '#64748b' },
  earningsVal: { fontSize: 20, fontWeight: '700', color: '#0f172a', marginTop: 4 },
  expenseRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#ffffff', padding: 12, borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  expDesc: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  expBranch: { fontSize: 11, color: '#64748b' },
  expAmount: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  expStatus: { fontSize: 10, fontWeight: '700', color: '#16a34a' },
  perfGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  perfBox: { width: '48%', backgroundColor: '#ffffff', padding: 16, borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', alignItems: 'center' },
  perfVal: { fontSize: 22, fontWeight: '700', color: '#2563eb' },
  perfLabel: { fontSize: 12, color: '#64748b', marginTop: 4, textAlign: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalContent: { backgroundColor: '#ffffff', borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a', marginBottom: 16 },
  catBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1' },
  catBtnActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 12, color: '#64748b', fontSize: 14 },
});
