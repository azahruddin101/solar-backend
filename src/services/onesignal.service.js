// OneSignal REST client (web push). Users are addressed by their external ID = our user id, which the
// frontend registers with OneSignal.login(). The REST key never leaves the backend.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ENDPOINT = 'https://api.onesignal.com/notifications?c=push';
const TIMEOUT_MS = 8000;

export const isOneSignalConfigured = () => Boolean(env.oneSignalAppId && env.oneSignalRestApiKey);

/** OneSignal wants a UUID idempotency key; derive a stable one so a retried event is de-duplicated. */
function uuidFrom(text) {
  const h = crypto.createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Send one push to the given user ids. Throws on failure — callers decide how to handle it. */
export async function sendPush({ userIds, title, body, url, data, idempotencyKey }) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return null;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${env.oneSignalRestApiKey}` },
    body: JSON.stringify({
      app_id: env.oneSignalAppId,
      target_channel: 'push',
      include_aliases: { external_id: ids },
      headings: { en: title },
      contents: { en: body },
      ...(url && { url }),
      ...(data && { data }),
      ...(idempotencyKey && { idempotency_key: uuidFrom(idempotencyKey) }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OneSignal ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  return json;
}
