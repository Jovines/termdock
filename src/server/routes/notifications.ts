import { Router, type Request } from 'express';
import {
  getPushSubscription,
  getVapidPublicKey,
  removePushSubscription,
  updatePushPreferences,
  upsertPushSubscription,
  type PushAlertStyle,
} from '../notifications/pushService.js';

const router = Router();

function clientIdFromRequest(req: Request): string {
  return typeof req.cookies?.['termdock-client'] === 'string' ? req.cookies['termdock-client'] : '';
}

function validAlertStyle(value: unknown): value is PushAlertStyle {
  return value === 'normal' || value === 'quiet' || value === 'persistent';
}

router.get('/status', (req, res) => {
  const subscription = getPushSubscription(clientIdFromRequest(req));
  res.json({
    publicKey: getVapidPublicKey(),
    subscribed: Boolean(subscription),
    subscription: subscription
      ? {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        aiEnabled: subscription.aiEnabled,
        exitEnabled: subscription.exitEnabled,
        alertStyle: subscription.alertStyle,
        locale: subscription.locale,
        updatedAt: subscription.updatedAt,
      }
      : null,
  });
});

router.post('/subscribe', (req, res) => {
  const clientId = clientIdFromRequest(req);
  const { subscription, aiEnabled, exitEnabled, alertStyle, locale } = req.body ?? {};
  if (
    !clientId
    || typeof subscription?.endpoint !== 'string'
    || subscription.endpoint.length > 4096
    || !subscription.endpoint.startsWith('https://')
    || typeof subscription?.keys?.p256dh !== 'string'
    || typeof subscription?.keys?.auth !== 'string'
    || subscription.keys.p256dh.length > 1024
    || subscription.keys.auth.length > 512
    || !validAlertStyle(alertStyle)
  ) {
    res.status(400).json({ error: 'Invalid push subscription' });
    return;
  }
  const saved = upsertPushSubscription(clientId, {
    endpoint: subscription.endpoint,
    expirationTime: typeof subscription.expirationTime === 'number'
      ? subscription.expirationTime
      : null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    aiEnabled: aiEnabled !== false,
    exitEnabled: exitEnabled === true,
    alertStyle,
    locale: typeof locale === 'string' ? locale.slice(0, 32) : 'zh-CN',
  });
  res.json({ ok: true, updatedAt: saved.updatedAt });
});

router.post('/preferences', (req, res) => {
  const { aiEnabled, exitEnabled, alertStyle, locale } = req.body ?? {};
  if (
    typeof aiEnabled !== 'boolean'
    || (exitEnabled !== undefined && typeof exitEnabled !== 'boolean')
    || !validAlertStyle(alertStyle)
  ) {
    res.status(400).json({ error: 'Invalid notification preferences' });
    return;
  }
  const updated = updatePushPreferences(clientIdFromRequest(req), {
    aiEnabled,
    // Optional so stale cached clients don't wipe the newer toggle.
    ...(typeof exitEnabled === 'boolean' ? { exitEnabled } : {}),
    alertStyle,
    locale: typeof locale === 'string' ? locale.slice(0, 32) : 'zh-CN',
  });
  res.status(updated ? 200 : 404).json({ ok: Boolean(updated) });
});

router.post('/unsubscribe', (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined;
  removePushSubscription(clientIdFromRequest(req), endpoint);
  res.json({ ok: true });
});

export default router;
