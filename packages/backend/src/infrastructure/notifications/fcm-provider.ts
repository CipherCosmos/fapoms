import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { NotificationPriority } from '@fapoms/shared';
import { PushProvider, PushPayload, PushResult } from './push-provider.interface';

/**
 * Android channel ids, mirrored exactly from the app's
 * `packages/mobile/src/services/notification.service.ts`. Naming a channel the app has not
 * declared means Android drops the push outright on API 26+, so these two lists must be
 * changed together.
 *
 * The `_v1` suffix exists because a channel's importance, sound and vibration are frozen at
 * creation time and can never be changed by the app afterwards. Retuning presentation always
 * means minting a NEW id (and deleting the old one app-side); reusing an id would silently
 * keep the old behaviour on every already-installed handset. These replaced the single
 * `fapoms_audit_alerts` channel, which put a routine notice through the same MAX-importance
 * heads-up popup as a genuine escalation.
 */
const ANDROID_CHANNELS: Record<NotificationPriority, string> = {
  [NotificationPriority.CRITICAL]: 'orbit_critical_v1',
  [NotificationPriority.HIGH]: 'orbit_high_v1',
  [NotificationPriority.NORMAL]: 'orbit_normal_v1',
  [NotificationPriority.LOW]: 'orbit_low_v1',
};

let initializeApp: any, cert: any, getApps: any, getMessaging: any;
try {
  // Optional dependency: firebase-admin may not be installed. A static import would crash the module
  // at load; require inside try/catch lets push notifications degrade gracefully when it is absent.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const adminApp = require('firebase-admin/app');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  /**
   * Whether a real credential loaded, matching `EmailProvider.isEnabled()`.
   *
   * Until now the only signal was a warning line at boot, which is why "push is blocked by a
   * placeholder Firebase config" survived in this project's notes long after it had stopped
   * being true. A deployment should be able to *ask*.
   */
  isEnabled(): boolean {
    return this.initialized;
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

  /**
   * The platform-specific half of a message, shared by `send` and `sendMulticast` so the two
   * cannot drift apart — they previously carried two hand-maintained copies of this block.
   */
  private buildDelivery(payload: Omit<PushPayload, 'token'>) {
    // Unknown priority is treated as NORMAL, never as urgent: over-alerting is the failure
    // mode being fixed here, so the fallback deliberately errs quiet.
    const priority = payload.priority ?? NotificationPriority.NORMAL;
    const isLow = priority === NotificationPriority.LOW;

    return {
      android: {
        // FCM's transport priority, not presentation. `high` is what wakes a dozing device;
        // low-priority notices can wait for the next maintenance window and save battery.
        priority: isLow ? 'normal' : 'high',
        notification: {
          title: payload.title,
          body: payload.body,
          channelId: ANDROID_CHANNELS[priority],
          // On API 26+ the channel wins over all of these; they only matter on older
          // handsets, where they are the sole way to keep a quiet notice quiet.
          sound: isLow ? undefined : 'default',
          priority: isLow ? 'low' : priority === NotificationPriority.CRITICAL ? 'max' : 'high',
          defaultSound: !isLow,
          defaultVibrateTimings: !isLow,
          // The white silhouette resource expo bakes from app.config's `notification.icon`.
          // Without naming it, Android falls back to a grey render of the launcher icon.
          icon: 'notification_icon',
          color: '#8B7CFF',
        },
      },
      apns: {
        // No `badge`. It used to be hardcoded to 1, so the icon read "1" whether the user had
        // one unread notification or forty. The honest alternative — the recipient's real
        // unread count — needs a per-recipient COUNT query on the send path, and multicast
        // sends to many devices in one call where a single number cannot be correct for all of
        // them. Omitting the key leaves the existing badge untouched rather than lying about it.
        payload: { aps: { sound: isLow ? undefined : 'default', contentAvailable: true } },
      },
    };
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
        ...this.buildDelivery(payload),
      };

      const messageId = await getMessaging().send(msg);
      return { success: true, messageId };
    } catch (err: any) {
      this.logger.error(`FCM send failed: ${err.message}`);
      return { success: false, error: err.message, errorCode: err?.code };
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
        ...this.buildDelivery(payload),
      };

      const response = await getMessaging().sendEachForMulticast(msg);
      return response.responses.map((r: any) => ({
        success: r.success,
        messageId: r.messageId ?? undefined,
        error: r.error?.message,
        errorCode: r.error?.code,
      }));
    } catch (err: any) {
      this.logger.error(`FCM multicast failed: ${err.message}`);
      return tokens.map(() => ({ success: false, error: err.message, errorCode: err?.code }));
    }
  }
}
