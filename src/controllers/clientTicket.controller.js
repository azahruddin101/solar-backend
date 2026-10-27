import * as tickets from '../services/clientTicket.service.js';

// Client support (company ↔ client). Used by both sides: the company workspace (/api/client-tickets) and the client
// portal (/api/portal/tickets); the service decides what each person may see and do.
export async function list(req, res) {
  res.json(await tickets.listClientTickets(req.user, req.query));
}
export async function unread(req, res) {
  const [unread, open] = await Promise.all([
    tickets.clientTicketUnreadCount(req.user),
    tickets.clientTicketOpenCount(req.user),
  ]);
  res.json({ unread, open });
}
export async function get(req, res) {
  res.json(await tickets.getClientTicket(req.user, req.params.id));
}
export async function create(req, res) {
  res.status(201).json(await tickets.createClientTicket(req.user, req.body, req.files));
}
export async function message(req, res) {
  res.status(201).json(await tickets.addClientTicketMessage(req.user, req.params.id, req.body, req.files));
}
export async function status(req, res) {
  res.json(await tickets.setClientTicketStatus(req.user, req.params.id, req.body?.status));
}
