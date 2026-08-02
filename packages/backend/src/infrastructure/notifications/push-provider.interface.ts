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
  /**
   * FCM's machine-readable code, e.g. `messaging/registration-token-not-registered`.
   *
   * The human `error` string is not safe to branch on — it is prose that changes
   * between SDK versions. Retrying a token FCM has told us is dead wastes the
   * queue forever, so the delivery worker needs to tell "this device is gone"
   * apart from "the network blipped", and that distinction only lives here.
   */
  errorCode?: string;
}

export interface PushProvider {
  send(payload: PushPayload): Promise<PushResult>;
  sendMulticast(tokens: string[], payload: Omit<PushPayload, 'token'>): Promise<PushResult[]>;
}
