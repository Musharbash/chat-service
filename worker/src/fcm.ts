import admin from 'firebase-admin';
import type { Logger } from './logger';
import type { AppConfig } from './config';

// FCM is initialized lazily. If FCM_SERVICE_ACCOUNT_JSON isn't set, push is a no-op
// (used in local dev where the main API still owns the notification path).

export interface PushClient {
  push(input: { tokens: string[]; title: string; body: string; data?: Record<string, string> }): Promise<{ sent: number; failed: number }>;
  enabled: boolean;
}

export function createPushClient(cfg: AppConfig, log: Logger): PushClient {
  if (!cfg.FCM_SERVICE_ACCOUNT_JSON || !cfg.FCM_PROJECT_ID) {
    log.warn('FCM not configured — push will be a no-op. Set FCM_SERVICE_ACCOUNT_JSON and FCM_PROJECT_ID to enable.');
    return {
      enabled: false,
      async push(): Promise<{ sent: number; failed: number }> {
        return { sent: 0, failed: 0 };
      },
    };
  }

  try {
    const creds = JSON.parse(cfg.FCM_SERVICE_ACCOUNT_JSON);
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(creds),
        projectId: cfg.FCM_PROJECT_ID,
      });
    }
  } catch (err) {
    log.error({ err }, 'failed to initialize FCM admin SDK — push disabled');
    return {
      enabled: false,
      async push(): Promise<{ sent: number; failed: number }> {
        return { sent: 0, failed: 0 };
      },
    };
  }

  return {
    enabled: true,
    async push({ tokens, title, body, data }): Promise<{ sent: number; failed: number }> {
      if (tokens.length === 0) return { sent: 0, failed: 0 };
      const messaging = admin.messaging();
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: data ?? {},
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
      });
      return { sent: response.successCount, failed: response.failureCount };
    },
  };
}
