import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { connectMobileSocket } from '../services/socket';
import { scheduleLocalNotification } from '../services/notification.service';
import { useAuth } from './AuthContext';

interface AssignmentContextType {
  assignments: AssayerAssignment[];
  loading: boolean;
  activeAssignment: AssayerAssignment | null;
  setActiveAssignment: (assignment: AssayerAssignment | null) => void;
  loadAssignments: () => Promise<void>;
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

const AssignmentContext = createContext<AssignmentContextType | undefined>(undefined);

export const AssignmentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [assignments, setAssignments] = useState<AssayerAssignment[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
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
    } catch (e) {
      console.error('Error loading assignments:', e);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user?.id]);

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
