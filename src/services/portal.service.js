// What a signed-in client may see: their own proposals (never drafts), the price breakdown, their bills and invoices.
// Clients may respond to proposals that are in “proposed” status (accept / reject / request changes).
import { Bill, Client, Design, Invoice, Payment, Project } from '../models/index.js';
import { toApiJSONList } from '../utils/lean.js';
import {
  amcKind,
  amcRequestRow,
  effectiveAmcVisits,
  ensureProjectAmc,
  submitClientAmcRequest,
  syncDesignAmcRequestsToProject,
} from './amc.service.js';
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
  subsidy: d.subsidy?.enabled ? { enabled: true, central: d.subsidy.central || 0, state: d.subsidy.state || 0 } : null,
  clientResponse: clientResponseRow(d),
  reviewInvite: reviewInviteRow(d),
  canRespond: OPEN_DESIGN_STATUS.includes(d.status) && !d.clientResponse?.decision,
});

export async function me(user) {
  const client = await Client.findOne({ _id: user.client, company: user.company }).select('name email phone address pan');
  if (!client) throw notFound('Client');
  return client;
}

export async function listProposals(user) {
  const designs = await Design.find({ company: user.company, client: user.client, status: VISIBLE }).select('-data -logs').sort({ updatedAt: -1 });
  const designIds = designs.map((d) => d._id);
  const [sums, company, projects] = await Promise.all([
    Payment.aggregate([{ $match: { company: user.company, design: { $in: designIds } } }, { $group: { _id: '$design', paid: { $sum: '$amount' } } }]),
    Company.findById(user.company).select('amcTemplates currency'),
    Project.find({ company: user.company, client: user.client, design: { $in: designIds } }).select('design status installationCompletedAt amcVisits amcOptionalSelections'),
  ]);
  const projectByDesign = new Map(projects.map((p) => [String(p.design), p]));
  return designs.map((d) => {
    const row = proposalRow(d);
    const paid = money(sums.find((s) => String(s._id) === d.id)?.paid);
    const amcPackages = amcPackagesViewForDesign(company, d, projectByDesign.get(d.id));
    return {
      ...row,
      paid,
      balance: row.status === 'won' ? money(row.total - paid) : null,
      amcPackages: amcPackages.hasCatalog ? amcPackages : null,
    };
  });
}

async function clientAmcVisits(user, designId) {
  const project = await Project.findOne({ company: user.company, design: designId, client: user.client }).select('status installationCompletedAt amcVisits amcOptionalSelections');
  if (!project) return { installationCompletedAt: null, visits: [] };
  const company = await Company.findById(user.company).select('amcTemplates');
  if (project.status === 'completed') await ensureProjectAmc(project, company);
  const visits = (project.amcVisits || []).map((v) => ({
    id: v.id,
    name: v.name,
    daysAfterInstallation: v.daysAfterInstallation,
    kind: amcKind(v.kind),
    price: v.price ?? 0,
    description: v.description || '',
    dueDate: v.dueDate,
    clientRequestedDate: v.clientRequestedDate,
    workflowStatus: v.workflowStatus,
    assignee: v.assignee ? { id: String(v.assignee), name: v.assigneeName || '' } : null,
    status: v.status,
    completedAt: v.completedAt,
    completedByName: v.completedByName || '',
    completionNote: v.completionNote || '',
    criteria: (v.criteria || []).map((c) => ({ id: c.id, label: c.label, checked: c.checked, note: c.note || '' })),
  }));
  return { installationCompletedAt: project.installationCompletedAt, visits };
}

function clientMayChooseAmcPackages(design) {
  return OPEN_DESIGN_STATUS.includes(design.status) || design.status === 'won';
}

/**
 * What the client sees about maintenance on one proposal. `included`: the mandatory AMCs, scheduled by the company for
 * every job (date, technician, status). `services`: the optional AMCs, each with the requests made for it — by the
 * client, or by the company on their behalf — newest first. The client can request a service again and again.
 */
function amcPackagesViewForDesign(company, design, project) {
  const templates = company?.amcTemplates || [];
  const visitByName = new Map((project ? effectiveAmcVisits(project, company) : []).map((v) => [v.name, v]));
  const included = templates.filter((t) => amcKind(t.kind) === 'mandatory').map((t) => {
    const v = visitByName.get(t.name);
    return {
      name: t.name,
      description: t.description || '',
      price: Number(t.price) || 0,
      visit: v ? { dueDate: v.dueDate || null, status: v.status, completedAt: v.completedAt || null, assignee: v.assigneeName ? { name: v.assigneeName } : null } : null,
    };
  });
  const requestsByPackage = new Map();
  for (const r of [...(design.amcRequests || [])].reverse()) {
    if (r.status === 'cancelled') continue;
    if (!requestsByPackage.has(r.packageName)) requestsByPackage.set(r.packageName, []);
    requestsByPackage.get(r.packageName).push(amcRequestRow(r));
  }
  const services = templates.filter((t) => amcKind(t.kind) === 'optional').map((t) => ({
    name: t.name,
    description: t.description || '',
    price: Number(t.price) || 0,
    requests: requestsByPackage.get(t.name) || [],
  }));
  return {
    currency: company?.currency || 'INR',
    hasCatalog: included.length + services.length > 0,
    canRequest: clientMayChooseAmcPackages(design),
    included,
    services,
  };
}

async function amcPackagesView(user, design, project = null) {
  const company = await Company.findById(user.company).select('amcTemplates currency');
  let proj = project;
  if (!proj) {
    proj = await Project.findOne({ company: user.company, design: design._id, client: user.client }).select('status installationCompletedAt amcVisits amcOptionalSelections');
  }
  return amcPackagesViewForDesign(company, design, proj);
}

/** Client asks for an optional AMC on a preferred date (or changes the date of one of their own requests). */
export async function submitAmcRequest(user, designId, body) {
  const design = await Design.findOne({
    _id: objectId(designId, 'Proposal'),
    company: user.company,
    client: user.client,
    status: VISIBLE,
  });
  if (!design) throw notFound('Proposal');
  const company = await Company.findById(user.company).select('amcTemplates');
  await submitClientAmcRequest({
    company,
    design,
    packageName: body.packageName,
    requestedDate: body.requestedDate,
    note: body.note,
    requestId: body.requestId || null,
  });
  return getProposal(user, designId);
}

export async function getProposal(user, id) {
  const design = await Design.findOne({ _id: objectId(id, 'Proposal'), company: user.company, client: user.client, status: VISIBLE }).select('-data -logs');
  if (!design) throw notFound('Proposal');
  const [payments, bills, invoice, client, amc, amcPackages] = await Promise.all([
    Payment.find({ company: user.company, design: design._id }).sort({ createdAt: 1 }),
    Bill.find({ company: user.company, design: design._id, status: { $ne: 'void' } }).sort({ createdAt: 1 }).populate('ewayBills', 'ewayNo issuedOn total').populate('invoice', 'invoiceNo').lean(),
    Invoice.findOne({ company: user.company, design: design._id, status: { $ne: 'void' }, kind: { $ne: 'amc_parts' } }).sort({ createdAt: -1 }),
    me(user),
    clientAmcVisits(user, design._id),
    amcPackagesView(user, design),
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
    bills: toApiJSONList(bills),
    invoice,
    amc,
    amcPackages,
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
    status: { $in: OPEN_DESIGN_STATUS },
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
