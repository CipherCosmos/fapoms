import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { PushProvider, PushPayload, PushResult } from './push-provider.interface';

let initializeApp: any, cert: any, getApps: any, getMessaging: any;
try {
  const adminApp = require('firebase-admin/app');
  const adminMsg = require('firebase-admin/messaging');
  initializeApp = adminApp.initializeApp;
  cert = adminApp.cert;
  getApps = adminApp.getApps;
  getMessaging = adminMsg.getMessaging;
} catch {
  // firebase-admin is optional
}

@Injectable()
export class FcmProvider implements PushProvider, OnModuleInit {
  private readonly logger = new Logger(FcmProvider.name);
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    if (!initializeApp || !getApps) {
      this.logger.warn('FCM module firebase-admin not installed — push notifications disabled');
      return;
    }
    const creds = this.loadCredentials();
    if (!creds) {
      this.logger.warn('FCM credentials not configured — push notifications disabled');
      return;
    }

    try {
      if (getApps().length === 0) {
        initializeApp({ credential: cert(creds) });
      }
      this.initialized = true;
      this.logger.log('FCM Push Notification Provider initialized');
    } catch (err: any) {
      this.logger.error(`Failed to initialize FCM: ${err.message}`);
    }
  }

  private loadCredentials(): { projectId: string; clientEmail: string; privateKey: string } | null {
    const projectId = this.configService.get<string>('FCM_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FCM_CLIENT_EMAIL');
    const privateKey = this.configService.get<string>('FCM_PRIVATE_KEY');

    if (projectId && clientEmail && privateKey) {
      return {
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      };
    }

    const possiblePaths = [
      resolve(process.cwd(), 'fapoms-gss-firebase-adminsdk-fbsvc-848e0d4888.json'),
      resolve(process.cwd(), 'service-account-key.json'),
    ];

    for (const filePath of possiblePaths) {
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed.project_id && parsed.client_email && parsed.private_key) {
            this.logger.log(`Loaded FCM credentials from ${filePath}`);
            return {
              projectId: parsed.project_id,
              clientEmail: parsed.client_email,
              privateKey: parsed.private_key,
            };
          }
        } catch {
          this.logger.warn(`Failed to parse ${filePath}`);
        }
      }
    }

    return null;
  }

  async send(payload: PushPayload): Promise<PushResult> {
    if (!this.initialized) {
      this.logger.warn('Push not sent — FCM not initialized');
      return { success: false, error: 'FCM not initialized' };
    }

    try {
      const msg: any = {
        token: payload.token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: 'high' },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      };

      const messageId = await getMessaging().send(msg);
      return { success: true, messageId };
    } catch (err: any) {
      this.logger.error(`FCM send failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async sendMulticast(tokens: string[], payload: Omit<PushPayload, 'token'>): Promise<PushResult[]> {
    if (!this.initialized) {
      return tokens.map(() => ({ success: false, error: 'FCM not initialized' }));
    }

    try {
      const msg: any = {
        tokens,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: 'high' },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      };

      const response = await getMessaging().sendEachForMulticast(msg);
      return response.responses.map((r: any) => ({
        success: r.success,
        messageId: r.messageId ?? undefined,
        error: r.error?.message,
      }));
    } catch (err: any) {
      this.logger.error(`FCM multicast failed: ${err.message}`);
      return tokens.map(() => ({ success: false, error: err.message }));
    }
  }
}
