import { Design, Estimate } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';

const MAX_LINES = 100;
const KINDS = ['package', 'product', 'service', 'custom'];
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, max = 1e9) => Math.min(max, Math.max(0, Number(v) || 0));
const round2 = (n) => Math.round(n * 100) / 100;

function cleanLine(l) {
  return {
    kind: KINDS.includes(l?.kind) ? l.kind : 'custom',
    refId: str(l?.refId, 40),
    name: str(l?.name, 140),
    detail: str(l?.detail, 600),
    hsn: str(l?.hsn, 20),
    unit: str(l?.unit, 20),
    qty: num(l?.qty, 1e7),
    rate: num(l?.rate),
    gstPercent: num(l?.gstPercent ?? 18, 100),
  };
}

/** Same arithmetic as the page (frontend/src/lib/estimation.js): GST per line, rounded to paise. */
function totalsOf(lines, withGst) {
  let subtotal = 0;
  let gstTotal = 0;
  for (const l of lines) {
    const amount = round2(l.qty * l.rate);
    subtotal += amount;
    if (withGst) gstTotal += round2((amount * l.gstPercent) / 100);
  }
  return { subtotal: round2(subtotal), gstTotal: round2(gstTotal), total: round2(subtotal + gstTotal) };
}

function clean(body) {
  const c = body?.client || {};
  const lines = (Array.isArray(body?.lines) ? body.lines : []).map(cleanLine);
  if (lines.length > MAX_LINES) throw badRequest(`An estimate can have up to ${MAX_LINES} items`);
  const withGst = body?.withGst !== false;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date || '') ? body.date : new Date().toISOString().slice(0, 10);
  const client = { clientId: str(c.clientId, 40), name: str(c.name, 120), phone: str(c.phone, 40), email: str(c.email, 200), address: str(c.address, 400) };
  if (!client.name) throw badRequest('Client name is required');
  if (!lines.length) throw badRequest('Add at least one item');
  return { client, date, withGst, lines, notes: str(body?.notes, 1000), ...totalsOf(lines, withGst) };
}

export const estimateService = {
  /** Newest first, without the lines. */
  async list(company, { q } = {}) {
    const match = { company: company._id };
    const needle = str(q, 80);
    if (needle) match['client.name'] = { $regex: needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const rows = await Estimate.find(match).select('-lines').sort({ createdAt: -1 }).limit(500).populate('design', 'name'); // a deleted proposal reads as none
    return rows;
  },

  async get(company, id) {
    const doc = await Estimate.findOne({ _id: objectId(id, 'Estimate'), company: company._id });
    if (!doc) throw notFound('Estimate');
    return doc;
  },

  create: async (company, user, body) => Estimate.create({ ...clean(body), company: company._id, createdByName: str(user?.name || user?.email, 120) }),

  async update(company, id, body) {
    const doc = await estimateService.get(company, id);
    Object.assign(doc, clean(body));
    return doc.save();
  },

  /** Note the proposal that was made from this estimate (the conversion itself happens on the page). */
  async markConverted(company, id, designId) {
    const design = await Design.findOne({ _id: objectId(designId, 'Proposal'), company: company._id }).select('_id');
    if (!design) throw notFound('Proposal');
    const doc = await Estimate.findOneAndUpdate({ _id: objectId(id, 'Estimate'), company: company._id }, { $set: { design: design._id } }, { returnDocument: 'after' });
    if (!doc) throw notFound('Estimate');
    return doc;
  },

  async remove(company, id) {
    const doc = await Estimate.findOneAndDelete({ _id: objectId(id, 'Estimate'), company: company._id });
    if (!doc) throw notFound('Estimate');
    return { ok: true };
  },
};
