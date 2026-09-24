import * as tickets from '../services/ticket.service.js';

export async function list(req, res) {
  res.json(await tickets.listTickets(req.user, req.query));
}
export async function unread(req, res) {
  res.json({ unread: await tickets.unreadCount(req.user) });
}
export async function get(req, res) {
  res.json(await tickets.getTicket(req.user, req.params.id));
}
export async function create(req, res) {
  res.status(201).json(await tickets.createTicket(req.user, req.body, req.files));
}
export async function message(req, res) {
  res.status(201).json(await tickets.addMessage(req.user, req.params.id, req.body, req.files));
}
export async function status(req, res) {
  res.json(await tickets.setStatus(req.user, req.params.id, req.body?.status));
}
