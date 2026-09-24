import * as notifications from '../services/notification.service.js';
import { objectId } from '../utils/validators.js';

export async function list(req, res) {
  res.json(await notifications.listFor(req.user, req.query));
}

export async function unread(req, res) {
  res.json({ unread: await notifications.unreadCount(req.user) });
}

export async function read(req, res) {
  await notifications.markRead(req.user, objectId(req.params.id, 'Notification'));
  res.json({ ok: true });
}

export async function readAll(req, res) {
  await notifications.markAllRead(req.user);
  res.json({ ok: true });
}
