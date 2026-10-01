// Designs a company creates for its clients. `data` is the designer's saved state.
import crypto from 'node:crypto';
import { CLIENT_PROJECT_TYPES, CLIENT_ROOF_TYPES, DESIGN_GRID_TYPES } from '../constants/index.js';
import { Client, Design, DesignVersion, Invoice, Payment } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';
import { deleteProjectsOf, moveDesignProject } from './project.service.js';
import { deleteFile } from './storage.service.js';
import { parsePagination, toApiJSONList } from '../utils/lean.js';

const SUMMARY = ['address', 'kwp', 'panels', 'cost', 'annualKwh', 'pricing'];
const DESIGN_SAVE_LOG_GAP_MS = 10 * 60 * 1000;

function appendLog(design, user, action, message = '') {
  if (!design.logs) design.logs = [];
  design.logs.push({
    action,
    by: user?._id || null,
    byName: user?.name || user?.email || 'System',
    byRole: user?.role || '',
    message: String(message || '').trim().slice(0, 1000),
  });
}

function shouldLogDesignSave(design) {
  const last = [...(design.logs || [])].reverse().find((l) => l.action === 'design_updated');
  if (!last?.at) return true;
  return Date.now() - new Date(last.at).getTime() > DESIGN_SAVE_LOG_GAP_MS;
}

export async function getDesign(company, id) {
  const design = await Design.findOne({ _id: objectId(id, 'Design'), company: company._id }).populate('client');
  if (!design) throw notFound('Design');
  return design;
}

async function ownClient(company, id) {
  const client = await Client.findOne({ _id: objectId(id, 'Client'), company: company._id });
  if (!client) throw badRequest('Choose one of your clients');
  return client;
}

async function checkLimit(company) {
  const { effectiveLimitsForCompany } = await import('./subscription.service.js');
  const max = (await effectiveLimitsForCompany(company)).maxDesigns;
  const message = `Your plan allows up to ${max} designs. Upgrade your plan or contact the platform administrator.`;
  if (!(max >= 1) || (await Design.countDocuments({ company: company._id })) >= max) throw forbidden(message);
  /** Call after inserting: two requests can pass the check above together, so re-count and undo the new design if the limit was passed. */
  return async (design) => {
    if ((await Design.countDocuments({ company: company._id })) > max) {
      await design.deleteOne();
      throw forbidden(message);
    }
  };
}

/** Lists leave out the heavy `data`. Paginated: pass `page`/`limit` (defaults to a single bounded page). */
export async function listDesigns(company, { client, page, limit } = {}) {
  const filter = { company: company._id };
  if (client) filter.client = objectId(client, 'Client');
  const { page: p, limit: l, skip } = parsePagination({ page, limit });
  const [items, total] = await Promise.all([
    Design.find(filter).select('-data').populate('client', 'name email').sort({ updatedAt: -1 }).skip(skip).limit(l).lean(),
    Design.countDocuments(filter),
  ]);
  return { items: toApiJSONList(items), total, page: p, limit: l };
}

/** Billing/servicing details on a proposal: billing name, loan needed, grid type, and cleaning terms. Only fields present in `body` are returned, so partial updates stay partial. */
function cleanBillingExtras(body = {}) {
  const out = {};
  if (body.billingName !== undefined) out.billingName = String(body.billingName || '').trim().slice(0, 160);
  if (body.loanRequired !== undefined) out.loanRequired = Boolean(body.loanRequired) && body.loanRequired !== 'false';
  if (body.gridType !== undefined) out.gridType = DESIGN_GRID_TYPES.includes(body.gridType) ? body.gridType : '';
  if (body.cleaningFrequency !== undefined) out.cleaningFrequency = Math.max(0, Math.min(365, Math.round(Number(body.cleaningFrequency) || 0)));
  if (body.cleaningCharge !== undefined) out.cleaningCharge = Math.max(0, Number(body.cleaningCharge) || 0);
  if (body.projectType !== undefined) out.projectType = CLIENT_PROJECT_TYPES.includes(body.projectType) ? body.projectType : 'residential';
  if (body.roofType !== undefined) out.roofType = CLIENT_ROOF_TYPES.includes(body.roofType) ? body.roofType : '';
  return out;
}

/** Installation charges picked on a proposal: [{ chargeId, name, price }]. */
export function cleanCharges(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 50)
    .map((c) => ({
      chargeId: String(c?.chargeId || ''),
      name: String(c?.name || '').trim().slice(0, 80),
      price: Math.max(0, Number(c?.price) || 0),
      gstPercent: Math.max(0, Math.min(100, Number(c?.gstPercent ?? 18) || 18)),
    }))
    .filter((c) => c.name);
}

/** A no-3D proposal: lines of packages/products with a quantity and price, plus GST, floor and installation charges. */
function cleanQuote(q = {}) {
  const items = (Array.isArray(q.items) ? q.items : []).slice(0, 100).map((it) => ({
    kind: it?.kind === 'package' ? 'package' : 'product',
    refId: String(it?.refId || ''),
    name: String(it?.name || '').trim().slice(0, 160),
    detail: String(it?.detail || '').trim().slice(0, 300),
    unit: String(it?.unit || '').trim().slice(0, 20),
    qty: Math.max(0, Number(it?.qty) || 0),
    price: Math.max(0, Number(it?.price) || 0),
  })).filter((it) => it.name);
  return {
    items,
    withGst: q.withGst !== false,
    gstIncluded: q.gstIncluded !== false,
    gstPercent: Math.max(0, Math.min(100, Number(q.gstPercent ?? 18) || 0)),
    floorPlacement: Math.max(0, Math.min(5, Math.round(Number(q.floorPlacement) || 0))),
    floorCost: Math.max(0, Number(q.floorCost) || 0),
    installationCharges: cleanCharges(q.installationCharges),
  };
}

/** 24 random characters (144 bits) — the only thing that lets someone open a proposal without signing in. */
export const newShareToken = () => crypto.randomBytes(18).toString('base64url');

/** The proposal's public link token, created the first time it is needed (older proposals have none yet). */
export async function ensureShare(company, id) {
  const design = await getDesign(company, id);
  if (!design.shareToken) {
    design.shareToken = newShareToken();
    await design.save();
  }
  return { token: design.shareToken };
}

/** Switches the public link (and the QR codes already printed on PDFs) off. A new link can be created afterwards. */
export async function revokeShare(company, id) {
  const design = await getDesign(company, id);
  design.set('shareToken', undefined);
  await design.save();
  return { token: null };
}

/** A date from the form ('2026-10-31'); empty clears it. */
function parseValidUntil(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest('Enter a valid date for “Valid until”');
  d.setHours(23, 59, 59, 0); // valid through the end of that day
  return d;
}

export async function createDesign(company, user, body) {
  const afterInsert = await checkLimit(company);
  const client = await ownClient(company, body?.client);
  const isQuick = body?.type === 'quick';
  const initialData = isQuick
    ? { quote: cleanQuote(body?.quote) }
    : (body?.pricingMode || body?.packageId || body?.floorPlacement !== undefined)
    ? {
        config: {
          pricingMode: body.pricingMode || 'custom',
          packageId: body.packageId || '',
          floorPlacement: Number(body.floorPlacement) || 0,
          floorCost: Number(body.floorCost) || 0,
          installationCharges: cleanCharges(body.installationCharges),
          outlookYears: Math.max(1, Math.min(30, Math.round(Number(body.outlookYears) || 10))),
          tariff: Math.max(0, Number(body.tariff) || 0),
        },
      }
    : null;
  const name = String(body?.name || '').trim() || `${client.name} – rooftop solar`;
  const design = await Design.create({
    company: company._id,
    client: client._id,
    name,
    validUntil: parseValidUntil(body?.validUntil) ?? null,
    shareToken: newShareToken(),
    type: isQuick ? 'quick' : '3d',
    data: initialData,
    ...cleanBillingExtras(body),
    logs: [],
  });
  await afterInsert(design);
  appendLog(design, user, 'design_created', name);
  await design.save();
  return design.populate('client');
}


export async function updateDesign(company, user, id, body) {
  const design = await getDesign(company, id);
  const prevStatus = design.status;
  const prevName = design.name;
  Object.assign(design, pick(body, ['name', 'status']));
  Object.assign(design, cleanBillingExtras(body));
  if (body?.validUntil !== undefined) design.validUntil = parseValidUntil(body.validUntil);
  if (body?.client !== undefined) {
    design.client = (await ownClient(company, body.client))._id;
    await moveDesignProject(design);
    appendLog(design, user, 'design_client_changed', 'Client updated');
  }
  if (body?.status !== undefined && body.status !== prevStatus) {
    appendLog(design, user, 'design_status_changed', `${prevStatus} → ${body.status}`);
    if (body.status === 'proposed') {
      design.set('clientResponse', undefined);
      design.set('clientReviewInvite', undefined);
    }
  }
  if (body?.name !== undefined && body.name !== prevName) {
    appendLog(design, user, 'design_renamed', `Renamed to “${design.name}”`);
  }
  if (body?.data !== undefined) {
    if (body.data !== null && typeof body.data !== 'object') throw badRequest('Invalid design data');
    design.data = body.data;
    design.markModified('data');
    if (shouldLogDesignSave(design)) appendLog(design, user, 'design_updated', 'Design workspace saved');
  }
  if (body?.summary) {
    Object.assign(design.summary, pick(body.summary, SUMMARY));
    design.markModified('summary');
    if (body?.data === undefined && shouldLogDesignSave(design)) appendLog(design, user, 'design_updated', 'Design summary updated');
  }
  await design.save();
  // the designer autosaves often — don't echo the whole document back
  return { id: design.id, name: design.name, status: design.status, validUntil: design.validUntil, updatedAt: design.updatedAt, clientResponse: design.clientResponse, clientReviewInvite: design.clientReviewInvite, billingName: design.billingName, loanRequired: design.loanRequired, gridType: design.gridType, cleaningFrequency: design.cleaningFrequency, cleaningCharge: design.cleaningCharge };
}

const DEFAULT_REVIEW_MESSAGE = 'I have made the changes you requested. Please review the updated proposal.';

/** After editing, ask the client to review again (clears their pending change request). */
export async function sendDesignForClientReview(company, user, id, { message } = {}) {
  const design = await getDesign(company, id);
  if (design.status !== 'proposed') throw badRequest('Set the proposal to Proposed before asking the client to review it.');
  if (design.clientResponse?.decision !== 'changes_requested') throw badRequest('The client has not asked for changes on this proposal.');

  const note = String(message || '').trim() || DEFAULT_REVIEW_MESSAGE;
  design.set('clientResponse', undefined);
  design.clientReviewInvite = { message: note, sentAt: new Date(), sentBy: user._id };
  appendLog(design, user, 'design_sent_for_client_review', note);
  await design.save();

  const { notifyClientProposalReadyForReview } = await import('./notification.service.js');
  notifyClientProposalReadyForReview({
    companyId: company._id,
    clientId: design.client._id,
    designId: design.id,
    designName: design.name,
    message: note,
    eventId: `${design.id}:${design.clientReviewInvite.sentAt.toISOString()}`,
  });

  return design.populate('client', 'name email');
}

export async function duplicateDesign(company, user, id) {
  const afterInsert = await checkLimit(company);
  const src = await getDesign(company, id);
  const copyName = `${src.name} (copy)`.slice(0, 120);
  const copy = await Design.create({ company: src.company, client: src.client._id, name: copyName, data: src.data, summary: src.summary, validUntil: null, shareToken: newShareToken(), logs: [] });
  await afterInsert(copy);
  appendLog(copy, user, 'design_created', copyName);
  appendLog(copy, user, 'design_duplicated', `Copied from “${src.name}”`);
  await copy.save();
  return copy.populate('client', 'name email');
}

/** Deleting a design also deletes its installation and stored PDF versions. */
export async function deleteDesign(company, id) {
  const design = await getDesign(company, id);
  if ((await Payment.exists({ design: design._id })) || (await Invoice.exists({ design: design._id }))) throw badRequest('This proposal has receipts or an invoice, so it cannot be deleted');
  await deleteProjectsOf({ design: design._id });
  const versions = await DesignVersion.find({ design: design._id }).select('pdfName');
  await Promise.all(versions.map((v) => deleteFile(v.pdfName)));
  await DesignVersion.deleteMany({ design: design._id });
  await design.deleteOne();
}

/** Super admin maintenance: every draft, across every company, abandoned for `days` or more — never touched, so no
 * Payment/Invoice/Project can exist on it, but each is still routed through `deleteDesign`'s own safety check anyway. */
export async function deleteStaleDraftDesigns(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stale = await Design.find({ status: 'draft', createdAt: { $lte: cutoff } }).select('_id company');
  let deleted = 0;
  const skipped = [];
  for (const d of stale) {
    try {
      await deleteDesign({ _id: d.company }, d._id);
      deleted++;
    } catch (e) {
      skipped.push({ id: d.id, reason: e.message });
    }
  }
  return { deleted, skipped: skipped.length, cutoff };
}

/** Every quotation PDF downloaded for this design, newest first (without the heavy `data`/`summary` snapshots). */
export function listDesignVersions(company, id) {
  return DesignVersion.find({ company: company._id, design: objectId(id, 'Design') }).select('-data').sort({ createdAt: -1 }).populate('createdBy', 'name email');
}

export async function getDesignVersion(company, designId, versionId) {
  const version = await DesignVersion.findOne({ _id: objectId(versionId, 'DesignVersion'), company: company._id, design: objectId(designId, 'Design') });
  if (!version) throw notFound('Design version');
  return version;
}

/** Sets the design's live data/summary back to an archived version's snapshot (the current state is not lost — it stays queryable in its own version, made the next time the PDF is downloaded). */
export async function restoreDesignVersion(company, user, designId, versionId) {
  const design = await getDesign(company, designId);
  const version = await getDesignVersion(company, designId, versionId);
  design.data = version.data;
  design.markModified('data');
  if (version.summary) {
    Object.assign(design.summary, pick(version.summary, SUMMARY));
    design.markModified('summary');
  }
  appendLog(design, user, 'design_version_restored', `Restored the version from ${new Date(version.createdAt).toLocaleString()}`);
  await design.save();
  return design.populate('client');
}

/** Records a downloaded quotation PDF as a traceable version, snapshotting the design's current data/summary. */
export async function createDesignVersion(company, user, id, pdfName) {
  const design = await getDesign(company, id);
  const version = await DesignVersion.create({
    company: company._id,
    design: design._id,
    createdBy: user?._id || null,
    pdfName,
    data: design.data,
    summary: design.summary,
  });
  appendLog(design, user, 'design_pdf_downloaded', 'Quotation PDF downloaded and archived as a version');
  await design.save();
  return version;
}
