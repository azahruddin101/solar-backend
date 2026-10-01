// What a signed-in client may see: their own proposals (never drafts), the price breakdown, and their payments.
// Clients may respond to proposals that are in “proposed” status (accept / reject / request changes).
import { Client, Design, Invoice, Payment } from '../models/index.js';
import { Company } from '../models/index.js';
import { designerCatalog } from './catalog.service.js';
import { notifyProposalResponse } from './notification.service.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { totalOf } from './billing.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const VISIBLE = { $ne: 'draft' };

const clientResponseRow = (d) => {
  const r = d.clientResponse;
  if (!r?.decision) return null;
  return { decision: r.decision, note: r.note || '', respondedAt: r.respondedAt };
};

const reviewInviteRow = (d) => {
  const r = d.clientReviewInvite;
  if (!r?.sentAt) return null;
  return { message: r.message || '', sentAt: r.sentAt };
};

const proposalRow = (d) => ({
  id: d.id,
  name: d.name,
  type: d.type,
  status: d.status,
  updatedAt: d.updatedAt,
  createdAt: d.createdAt,
  summary: { address: d.summary?.address, kwp: d.summary?.kwp, panels: d.summary?.panels, annualKwh: d.summary?.annualKwh, cost: d.summary?.cost },
  total: totalOf(d),
  clientResponse: clientResponseRow(d),
  reviewInvite: reviewInviteRow(d),
  canRespond: d.status === 'proposed' && !d.clientResponse?.decision,
});

export async function me(user) {
  const client = await Client.findOne({ _id: user.client, company: user.company }).select('name email phone address pan');
  if (!client) throw notFound('Client');
  return client;
}

export async function listProposals(user) {
  const designs = await Design.find({ company: user.company, client: user.client, status: VISIBLE }).select('-data -logs').sort({ updatedAt: -1 });
  const sums = await Payment.aggregate([{ $match: { company: user.company, design: { $in: designs.map((d) => d._id) } } }, { $group: { _id: '$design', paid: { $sum: '$amount' } } }]);
  return designs.map((d) => {
    const row = proposalRow(d);
    const paid = money(sums.find((s) => String(s._id) === d.id)?.paid);
    return { ...row, paid, balance: row.status === 'won' ? money(row.total - paid) : null };
  });
}

export async function getProposal(user, id) {
  const design = await Design.findOne({ _id: objectId(id, 'Proposal'), company: user.company, client: user.client, status: VISIBLE }).select('-data -logs');
  if (!design) throw notFound('Proposal');
  const [payments, invoice, client] = await Promise.all([
    Payment.find({ company: user.company, design: design._id }).sort({ createdAt: 1 }),
    Invoice.findOne({ company: user.company, design: design._id }).sort({ createdAt: -1 }),
    me(user),
  ]);
  const total = totalOf(design);
  const paid = money(payments.reduce((a, p) => a + p.amount, 0));
  return {
    proposal: { ...proposalRow(design), pricing: design.summary?.pricing || null },
    client,
    total,
    paid,
    balance: design.status === 'won' ? money(total - paid) : null,
    payments,
    invoice,
  };
}

const RESPONSE_LOG = {
  accepted: 'client_proposal_accepted',
  rejected: 'client_proposal_rejected',
  changes_requested: 'client_proposal_changes_requested',
};

function appendClientLog(design, user, action, message) {
  if (!design.logs) design.logs = [];
  design.logs.push({
    action,
    by: user._id,
    byName: user.name || user.email || 'Client',
    byRole: user.role || 'client',
    message: String(message || '').trim().slice(0, 1000),
  });
}

/** Accept, reject, or request changes on a proposal that is currently “proposed”. */
export async function respondToProposal(user, id, { decision, note }) {
  const design = await Design.findOne({
    _id: objectId(id, 'Proposal'),
    company: user.company,
    client: user.client,
    status: 'proposed',
  });
  if (!design) throw badRequest('This proposal is not open for a response right now.');
  if (design.clientResponse?.decision) throw badRequest('You have already responded to this proposal. Contact your provider if you need to change your answer.');

  design.clientResponse = {
    decision,
    note,
    respondedAt: new Date(),
    respondedBy: user._id,
  };
  if (decision === 'accepted') design.status = 'won';
  else if (decision === 'rejected') design.status = 'lost';
  design.set('clientReviewInvite', undefined);

  const logAction = RESPONSE_LOG[decision] || 'client_proposal_response';
  appendClientLog(design, user, logAction, note);
  if (decision === 'accepted' || decision === 'rejected') {
    appendClientLog(design, user, 'design_status_changed', `proposed → ${design.status}`);
  }

  await design.save();
  notifyProposalResponse({
    companyId: user.company,
    designId: design.id,
    designName: design.name,
    designType: design.type,
    decision,
    note,
    eventId: `${design.id}:${design.clientResponse.respondedAt.toISOString()}`,
  });
  return getProposal(user, id);
}

/** The saved 3D design of one of the client's own proposals — everything the viewer needs to draw it. */
export async function getDesignData(user, id) {
  const design = await Design.findOne({ _id: objectId(id, 'Proposal'), company: user.company, client: user.client, status: VISIBLE }).select('-logs');
  if (!design) throw notFound('Proposal');
  if (design.type === 'quick' || !design.data?.sections?.length) throw badRequest('This proposal has no 3D design');
  const client = await me(user);
  return { id: design.id, name: design.name, status: design.status, data: design.data, summary: { address: design.summary?.address, kwp: design.summary?.kwp, panels: design.summary?.panels, annualKwh: design.summary?.annualKwh }, client: { id: client.id, name: client.name, address: client.address } };
}

/** What the viewer needs to size the panels and poles — without the company's prices, packages or other products. */
export async function viewerCatalog(user) {
  return viewerCatalogFor(user.company);
}

export async function viewerCatalogFor(companyId) {
  const company = await Company.findById(companyId);
  const c = await designerCatalog(company);
  return {
    currency: c.currency,
    tariff: c.tariff,
    otherCostPerKw: 0,
    panels: c.panels.map((p) => ({ ...p, price: 0 })),
    pillars: c.pillars.map((p) => ({ ...p, pricePerFt: 0 })),
    packages: [],
    materialCategories: [],
  };
}
