import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { connectMobileSocket } from '../services/socket';
import { scheduleLocalNotification } from '../services/notification.service';
import { useAuth } from './AuthContext';
import { readCache, writeCache } from '../services/token-store';

interface AssignmentContextType {
  assignments: AssayerAssignment[];
  loading: boolean;
  activeAssignment: AssayerAssignment | null;
  setActiveAssignment: (assignment: AssayerAssignment | null) => void;
  loadAssignments: () => Promise<void>;
  /** The list on screen came from cache because the last refresh failed. */
  stale: boolean;
  lastSyncedAt: string | null;
  updateAssignmentStatus: (
    assignmentId: string,
    status: AssayerAssignment['status'],
    notes?: string,
    reportData?: { pdfName?: string; data?: any; proposedFee?: number }
  ) => Promise<{ success: boolean; error?: string }>;
  rejectAssignment: (assignmentId: string, reason: string) => Promise<{ success: boolean; error?: string }>;
  submitExpense: (
    assignmentId: string,
    expense: { category: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'; amount: number; description?: string }
  ) => Promise<{ success: boolean; error?: string }>;
}

const CACHE_KEY = 'assignments';

const AssignmentContext = createContext<AssignmentContextType | undefined>(undefined);

export const AssignmentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [assignments, setAssignments] = useState<AssayerAssignment[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  /** True when the last refresh failed and the list on screen is from cache. */
  const [stale, setStale] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [activeAssignment, setActiveAssignment] = useState<AssayerAssignment | null>(null);

  const loadAssignments = useCallback(async () => {
    if (!isAuthenticated) {
      setAssignments([]);
      return;
    }
    setLoading(true);
    try {
      const items = await MobileApiService.getAssayerAssignments(user?.id);
      setAssignments(items);
      setStale(false);
      setLastSyncedAt(new Date().toISOString());
      void writeCache(CACHE_KEY, { items, at: new Date().toISOString() });
    } catch (e) {
      /**
       * A failed refresh keeps whatever is already on screen and says so.
       *
       * This used to log and leave the list as-is with no indication, so an assayer standing
       * in a vault could not tell the difference between "no work today" and "the app could
       * not reach the server". Marking it stale is what lets the UI say which.
       */
      console.warn('Could not refresh assignments; showing last synced data:', e);
      setStale(true);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user?.id]);

  /**
   * Paints the last synced schedule before the network is even attempted.
   *
   * Cold start previously blocked the first useful frame on a round trip, which on rural data
   * is seconds of empty screen; and with no signal it never arrived at all.
   */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    readCache<{ items: AssayerAssignment[]; at: string }>(CACHE_KEY).then((cached) => {
      if (cancelled || !cached?.items?.length) return;
      setAssignments((current) => (current.length > 0 ? current : cached.items));
      setLastSyncedAt(cached.at);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      loadAssignments();
      const socket = connectMobileSocket();

      const handleStatusChange = (data: any) => {
        loadAssignments();
        scheduleLocalNotification(
          'Assignment Update',
          `An assignment status has been updated to ${data?.status || 'NEW'}`,
          data
        );
      };

      if (socket) {
        socket.on('assignment:status-changed', handleStatusChange);
        socket.on('assignment:counter-offered', handleStatusChange);
      }

      return () => {
        if (socket) {
          socket.off('assignment:status-changed', handleStatusChange);
          socket.off('assignment:counter-offered', handleStatusChange);
        }
      };
    }
  }, [isAuthenticated, loadAssignments]);

  const updateAssignmentStatus = async (
    assignmentId: string,
    status: AssayerAssignment['status'],
    notes?: string,
    reportData?: { pdfName?: string; data?: any; proposedFee?: number }
  ) => {
    try {
      const success = await MobileApiService.updateAssignmentStatus(
        assignmentId,
        status,
        notes,
        reportData?.proposedFee
      );
      if (success) {
        await loadAssignments();
        return { success: true };
      }
      return { success: false, error: 'Failed to update assignment status' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error' };
    }
  };

  const rejectAssignment = async (assignmentId: string, reason: string) => {
    try {
      const result = await MobileApiService.rejectAssignment(assignmentId, reason);
      if (result.success) {
        await loadAssignments();
        return { success: true };
      }
      return { success: false, error: result.error || 'Failed to reject assignment' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error' };
    }
  };

  const submitExpense = async (
    assignmentId: string,
    expense: { category: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'; amount: number; description?: string }
  ) => {
    try {
      const result = await MobileApiService.submitExpense(assignmentId, expense);
      if (result.success) {
        await loadAssignments();
        return { success: true };
      }
      return { success: false, error: result.error || 'Failed to submit expense' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error' };
    }
  };

  return (
    <AssignmentContext.Provider
      value={{
        assignments,
        loading,
        activeAssignment,
        setActiveAssignment,
        loadAssignments,
        stale,
        lastSyncedAt,
        updateAssignmentStatus,
        rejectAssignment,
        submitExpense,
      }}
    >
      {children}
    </AssignmentContext.Provider>
  );
};

export const useAssignments = (): AssignmentContextType => {
  const context = useContext(AssignmentContext);
  if (!context) {
    throw new Error('useAssignments must be used within an AssignmentProvider');
  }
  return context;
};
