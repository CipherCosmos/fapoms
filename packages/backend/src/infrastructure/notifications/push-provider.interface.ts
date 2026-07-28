export interface PushPayload {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface PushProvider {
  send(payload: PushPayload): Promise<PushResult>;
  sendMulticast(tokens: string[], payload: Omit<PushPayload, 'token'>): Promise<PushResult[]>;
}
