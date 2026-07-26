import { AssayerAssignment } from '../types/mobile-app';

const API_BASE_URL = 'http://localhost:3000/api/v1';

export class MobileApiService {
  static async getAssayerAssignments(assayerId: string): Promise<AssayerAssignment[]> {
    try {
      const response = await fetch(`${API_BASE_URL}/assignments/assayer/${assayerId}`);
      if (!response.ok) throw new Error('Failed to fetch assignments');
      const data = await response.json();
      return data.items || [];
    } catch (error) {
      console.error('Failed to connect to backend REST API:', error);
      return [];
    }
  }

  static async updateAssignmentStatus(
    assignmentId: string,
    status: AssayerAssignment['status'],
    reason?: string,
  ): Promise<boolean> {
    const response = await fetch(`${API_BASE_URL}/assignments/${assignmentId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetStatus: status, reason }),
    });
    return response.ok;
  }

  static async checkInBranch(assignmentId: string, lat: number, lng: number, syncToken?: string): Promise<{ success: boolean; error?: string }> {
    const response = await fetch(`${API_BASE_URL}/assignments/${assignmentId}/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, syncToken, timestamp: new Date().toISOString() }),
    });
    const resData = await response.json().catch(() => ({}));
    return {
      success: response.ok && resData.success !== false,
      error: resData.error,
    };
  }

  static async saveCustomerAudit(
    assignmentId: string,
    customerId: string,
    auditedGrossWeight: number,
    auditedNetWeight: number,
    purityKarat: number,
    sealIntact: boolean,
    remarks?: string,
  ): Promise<boolean> {
    const response = await fetch(`${API_BASE_URL}/validation/records/${customerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auditedGrossWeightGrams: auditedGrossWeight,
        auditedNetWeightGrams: auditedNetWeight,
        purityKarat,
        sealIntact,
        remarks,
        status: 'AUDITED',
      }),
    });
    return response.ok;
  }

  static async respondToQuery(queryId: string, responseText: string): Promise<boolean> {
    const response = await fetch(`${API_BASE_URL}/validation/queries/${queryId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: responseText }),
    });
    return response.ok;
  }

  static async submitExpense(assignmentId: string, category: string, amount: number, description: string): Promise<boolean> {
    const response = await fetch(`${API_BASE_URL}/ledger/expenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentId, category, amount, description }),
    });
    return response.ok;
  }
}
