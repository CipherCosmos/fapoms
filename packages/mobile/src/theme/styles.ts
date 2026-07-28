import { StyleSheet, Platform } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#090d16',
    minHeight: '100vh' as any,
  },

  // ── Header ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(99, 102, 241, 0.25)',
    ...Platform.select({ web: { backdropFilter: 'blur(12px)' } as any }),
  },
  appTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: -0.5,
    fontFamily: Platform.OS === 'web' ? 'Outfit, Inter, system-ui, sans-serif' : undefined,
  },
  assayerSubtitle: {
    fontSize: 12,
    color: '#38bdf8',
    marginTop: 1,
    fontWeight: '600',
    opacity: 0.9,
  },
  refreshBtn: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
  },
  refreshBtnText: {
    color: '#a5b4fc',
    fontSize: 14,
    fontWeight: '700',
  },
  notifBellBtn: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.25)',
    position: 'relative',
  },
  notifBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#ef4444',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: '#0f172a',
  },
  notifBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '900',
  },

  // ── Tab Bar ──
  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
    paddingHorizontal: 4,
    ...Platform.select({ web: { backdropFilter: 'blur(12px)' } as any }),
  },
  tabItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 2,
    borderRadius: 8,
    marginHorizontal: 2,
  },
  activeTabItem: {
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    borderBottomWidth: 2,
    borderBottomColor: '#6366f1',
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
  },
  activeTabLabel: {
    color: '#a5b4fc',
    fontWeight: '800',
  },

  // ── Content ──
  contentScroll: {
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 20,
  },
  sectionHeading: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 14,
    letterSpacing: -0.3,
  },
  subHeading: {
    fontSize: 15,
    fontWeight: '700',
    color: '#cbd5e1',
    marginTop: 18,
    marginBottom: 10,
  },

  // ── Glass Card ──
  card: {
    backgroundColor: 'rgba(30, 41, 59, 0.85)',
    borderRadius: 18,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.15)',
    ...Platform.select({ web: { backdropFilter: 'blur(8px)' } as any }),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 6,
  },
  branchSubText: {
    fontSize: 13,
    color: '#94a3b8',
    lineHeight: 19,
    marginBottom: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  seqBadge: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.4)',
  },
  seqText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#a5b4fc',
  },
  statusBadge: {
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    overflow: 'hidden',
  },

  // ── Status Colors ──
  status_PENDING: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    color: '#fbbf24',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  status_ACCEPTED: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
    color: '#60a5fa',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.4)',
  },
  status_CHECKED_IN: {
    backgroundColor: 'rgba(234, 179, 8, 0.2)',
    color: '#facc15',
    borderWidth: 1,
    borderColor: 'rgba(234, 179, 8, 0.4)',
  },
  status_IN_PROGRESS: {
    backgroundColor: 'rgba(168, 85, 247, 0.2)',
    color: '#c084fc',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.4)',
  },
  status_COMPLETED: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    color: '#34d399',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  status_REJECTED: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    color: '#f87171',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },

  // ── Branch Info ──
  branchName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
  },
  address: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 6,
    lineHeight: 19,
  },

  // ── Metrics Row ──
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    padding: 12,
    borderRadius: 14,
    marginTop: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  metricBox: {
    alignItems: 'center',
    flex: 1,
  },
  metricLabel: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
  },
  metricVal: {
    fontSize: 16,
    fontWeight: '800',
    color: '#38bdf8',
    marginTop: 3,
  },

  // ── Action Grid ──
  actionGrid: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  acceptBtn: {
    flex: 1,
    backgroundColor: '#10b981',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  rejectBtn: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  mapBtn: {
    flex: 1,
    backgroundColor: '#334155',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  checkInBtn: {
    flex: 1,
    backgroundColor: '#f59e0b',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#6366f1',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitFinalBtn: {
    backgroundColor: '#059669',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },

  // ── Button Text ──
  btnTextWhite: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },
  btnTextDark: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },

  // ── Customer ──
  customerFormTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
  },
  customerSub: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 2,
  },
  customerPledged: {
    fontSize: 14,
    color: '#38bdf8',
    marginTop: 6,
    fontWeight: '700',
  },

  // ── Form Inputs ──
  inputGroup: {
    marginTop: 14,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
    marginBottom: 6,
  },
  textInput: {
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    color: '#ffffff',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
  },
  toggleBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  toggleOn: {
    backgroundColor: '#10b981',
  },
  toggleOff: {
    backgroundColor: '#ef4444',
  },
  saveBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 18,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
  },
  backBtn: {
    marginBottom: 14,
  },
  backBtnText: {
    color: '#818cf8',
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Customer Row ──
  customerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 41, 59, 0.85)',
    padding: 16,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  customerRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  customerIndex: {
    fontSize: 15,
    fontWeight: '800',
    color: '#64748b',
  },
  customerNameText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
  },
  accountText: {
    fontSize: 13,
    color: '#94a3b8',
  },
  custStatusBadge: {
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    overflow: 'hidden',
  },
  custAudited: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    color: '#34d399',
  },
  custPending: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    color: '#fbbf24',
  },
  addExpBtn: {
    backgroundColor: '#334155',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 18,
  },

  // ── Empty State ──
  emptyBox: {
    padding: 30,
    alignItems: 'center',
    backgroundColor: 'rgba(30, 41, 59, 0.7)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 14,
  },

  // ── Queries ──
  queryValidator: {
    fontSize: 14,
    fontWeight: '800',
    color: '#818cf8',
  },
  queryStatus: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fbbf24',
  },
  queryCust: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
    marginTop: 4,
  },
  queryBody: {
    fontSize: 14,
    color: '#fde68a',
    marginTop: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    padding: 12,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#f59e0b',
  },
  responseBox: {
    marginTop: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    padding: 12,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#10b981',
  },
  responseTextTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#34d399',
  },
  responseText: {
    fontSize: 13,
    color: '#a7f3d0',
    marginTop: 3,
  },
  respondBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },

  // ── Earnings ──
  earningsSummaryGrid: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 18,
  },
  earningsCard: {
    flex: 1,
    backgroundColor: 'rgba(30, 41, 59, 0.85)',
    padding: 18,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.15)',
    alignItems: 'center',
  },
  earningsLabel: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
  },
  earningsVal: {
    fontSize: 24,
    fontWeight: '800',
    color: '#34d399',
    marginTop: 6,
  },

  // ── Expense Row ──
  expenseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 41, 59, 0.85)',
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  expDesc: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
  expBranch: {
    fontSize: 12,
    color: '#94a3b8',
  },
  expAmount: {
    fontSize: 15,
    fontWeight: '800',
    color: '#38bdf8',
  },
  expStatus: {
    fontSize: 11,
    fontWeight: '800',
    color: '#34d399',
  },

  // ── Performance ──
  perfGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  perfBox: {
    width: '47%',
    backgroundColor: 'rgba(30, 41, 59, 0.85)',
    padding: 18,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.15)',
    alignItems: 'center',
  },
  perfVal: {
    fontSize: 28,
    fontWeight: '800',
    color: '#818cf8',
  },
  perfLabel: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 6,
    textAlign: 'center',
    fontWeight: '600',
  },

  // ── Modals ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: 'rgba(30, 41, 59, 0.95)',
    borderRadius: 22,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.25)',
    ...Platform.select({ web: { backdropFilter: 'blur(16px)' } as any }),
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 18,
  },
  catBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
  },
  catBtnActive: {
    backgroundColor: '#6366f1',
    borderColor: '#818cf8',
  },

  // ── Utility ──
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 14,
    color: '#94a3b8',
    fontSize: 15,
    fontWeight: '600',
  },
});
