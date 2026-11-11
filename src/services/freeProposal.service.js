// The free proposal maker: a visitor on the public site (no sign-in) types their company, their client, the solar
// system, the price lines and the terms, picks a design and downloads a proposal PDF. Nothing is pre-filled and
// nothing is read from a workspace. Each proposal is kept on its own (FreeProposal), with the visitor's device and
// where they were, as a lead for the platform admin (Admin console → Free proposals).
import crypto from 'node:crypto';
import { FreeProposal } from '../models/index.js';
import { FREE_PROPOSAL_STATUS } from '../models/freeProposal.model.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { toApiJSON, toApiJSONList } from '../utils/lean.js';
import { cleanRichText } from '../utils/richText.js';
import { objectId } from '../utils/validators.js';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const clip = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, { min = 0, max = 1e12 } = {}) => {
  const n = Number(v);
  return v !== '' && v != null && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
};
const coord = (v, lim) => {
  const n = Number(v);
  return v !== '' && v != null && Number.isFinite(n) && Math.abs(n) <= lim ? n : null;
};
/** Text from the rich text editor (headings, lists, bold…), sanitised; plain text becomes a list of its lines. */
const richText = (v, what) => {
  try {
    return cleanRichText(v);
  } catch {
    throw badRequest(`The ${what} are too long`);
  }
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const COVERS = ['magazine', 'photo', 'panel', 'minimal'];
const LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO = 400 * 1024; // characters of the data: image

/**
 * The money of a proposal, from its lines: each line is quantity × rate; the discount comes off every line in
 * proportion, then each line's own tax is added. (The same sums as frontend/src/lib/freeProposalCalc.js.)
 */
export function proposalTotals(items = [], pricing = {}) {
  const lines = items.map((it) => ({ amount: round2(num(it.qty) * num(it.rate)), taxPercent: num(it.taxPercent, { max: 100 }) }));
  const subtotal = round2(lines.reduce((a, l) => a + l.amount, 0));
  const discountAmount = round2(Math.min(subtotal, pricing.discountIsPercent ? (subtotal * num(pricing.discount, { max: 100 })) / 100 : num(pricing.discount)));
  const keep = subtotal > 0 ? 1 - discountAmount / subtotal : 1;
  const taxable = round2(subtotal - discountAmount);
  const tax = round2(lines.reduce((a, l) => a + (l.amount * keep * l.taxPercent) / 100, 0));
  const total = round2(taxable + tax);
  const subsidy = round2(Math.min(total, num(pricing.subsidy)));
  return { subtotal, discountAmount, taxable, tax, total, subsidy, net: round2(total - subsidy) };
}

/** Only what the maker asks for, trimmed to size. Throws when something it needs is missing. */
export function cleanProposal(body = {}) {
  const c = body.company || {};
  const cl = body.client || {};
  const s = body.system || {};
  const p = body.pricing || {};
  const t = body.terms || {};
  const d = body.design || {};
  const company = { name: clip(c.name, 160), contactName: clip(c.contactName, 120), phone: clip(c.phone, 20), email: clip(c.email, 160).toLowerCase(), address: clip(c.address, 400), taxId: clip(c.taxId, 30), website: clip(c.website, 160) };
  const client = { name: clip(cl.name, 160), phone: clip(cl.phone, 20), email: clip(cl.email, 160).toLowerCase(), address: clip(cl.address, 400) };
  const system = {
    title: clip(s.title, 160),
    type: clip(s.type, 40),
    kw: num(s.kw, { max: 1e6 }),
    panelCount: Math.round(num(s.panelCount, { max: 1e7 })),
    panelBrand: clip(s.panelBrand, 120),
    panelWatts: num(s.panelWatts, { max: 2000 }),
    inverter: clip(s.inverter, 160),
    structure: clip(s.structure, 160),
    warranty: clip(s.warranty, 200),
    annualKwh: num(s.annualKwh, { max: 1e10 }),
    tariff: num(s.tariff, { max: 1e6 }),
  };
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 80)
    .map((it) => ({ name: clip(it?.name, 160), description: clip(it?.description, 400), qty: num(it?.qty, { max: 1e9 }), unit: clip(it?.unit, 20), rate: num(it?.rate), taxPercent: num(it?.taxPercent, { max: 100 }) }))
    .filter((it) => it.name);
  const pricing = { currency: /^[A-Z]{3}$/.test(String(p.currency || '')) ? p.currency : 'INR', discount: num(p.discount), discountIsPercent: Boolean(p.discountIsPercent), discountRemark: clip(p.discountRemark, 200), subsidy: num(p.subsidy) };
  const terms = { validUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(t.validUntil || '')) ? t.validUntil : '', payment: richText(t.payment, 'payment terms'), conditions: richText(t.conditions, 'terms & conditions'), notes: richText(t.notes, 'notes') };
  const design = { cover: COVERS.includes(d.cover) ? d.cover : 'magazine', primary: HEX.test(d.primary || '') ? d.primary : '#1D4ED8', accent: HEX.test(d.accent || '') ? d.accent : '#F5B82E' };

  if (company.name.length < 2) throw badRequest('Enter your company name');
  if (company.contactName.length < 2) throw badRequest('Enter your name');
  if (company.phone.replace(/\D/g, '').length < 7) throw badRequest('Enter your mobile number');
  if (client.name.length < 2) throw badRequest('Enter your client’s name');
  if (!(system.kw > 0)) throw badRequest('Enter the size of the system in kW');
  if (!items.length) throw badRequest('Add at least one item with its quantity and rate');
  for (const it of items) if (!(it.qty > 0)) throw badRequest(`Enter the quantity of ${it.name}`);

  const logo = typeof body.logo === 'string' && body.logo.length <= MAX_LOGO && LOGO.test(body.logo) ? body.logo : '';
  return { data: { company, client, system, items, pricing, terms, design }, logo, totals: proposalTotals(items, pricing) };
}

/** Browser, system and kind of device from a user-agent string (the common ones; anything else is left blank). */
export function parseUserAgent(ua = '') {
  const s = String(ua);
  const pick = (list) => list.find(([re]) => re.test(s))?.[1] || '';
  const browser = pick([[/Edg\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/SamsungBrowser/, 'Samsung Internet'], [/Firefox\/|FxiOS/, 'Firefox'], [/Chrome\/|CriOS/, 'Chrome'], [/Safari\//, 'Safari']]);
  const os = pick([[/Windows NT/, 'Windows'], [/Android/, 'Android'], [/iPhone|iPad|iPod/, 'iOS'], [/Mac OS X/, 'macOS'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux']]);
  const type = /iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s)) ? 'tablet' : /Mobi|iPhone|iPod|Android/.test(s) ? 'mobile' : s ? 'desktop' : '';
  return { browser, os, type };
}

/** What the visitor may see of their own proposal: what they typed, never the device, location or admin fields. */
const visitorView = (row) => {
  const j = toApiJSON(row);
  return { refNo: j.refNo, token: j.token, data: j.data, logo: j.logo, totals: j.totals, createdAt: j.createdAt, updatedAt: j.updatedAt };
};

const newRef = () => `FP-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const leadFields = ({ data }) => ({ companyName: data.company.name, contactName: data.company.contactName, phone: data.company.phone, email: data.company.email, clientName: data.client.name });

/** What is kept of the visitor's device and place. `meta` = `{ ip, userAgent, referrer }` as the server saw them. */
function visitorMeta(body = {}, meta = {}) {
  const d = body.device && typeof body.device === 'object' ? body.device : {};
  const p = body.position && typeof body.position === 'object' ? body.position : {};
  const userAgent = clip(meta.userAgent, 400);
  const lat = coord(p.lat, 90);
  const lng = coord(p.lng, 180);
  const both = lat != null && lng != null;
  return {
    device: { userAgent, ...parseUserAgent(userAgent), screen: clip(d.screen, 20), language: clip(d.language, 20), platform: clip(d.platform, 60) },
    location: { ip: clip(meta.ip, 60), timezone: clip(d.timezone, 60), lat: both ? lat : null, lng: both ? lng : null, accuracyM: both ? coord(p.accuracy, 1e7) : null },
    referrer: clip(meta.referrer, 300),
  };
}

/** Save a new free proposal. */
export async function createFreeProposal(body = {}, meta = {}) {
  const clean = cleanProposal(body);
  const doc = { ...clean, ...leadFields(clean), ...visitorMeta(body, meta), token: crypto.randomBytes(18).toString('base64url') };
  for (let attempt = 0; ; attempt++) {
    try {
      return visitorView((await FreeProposal.create({ ...doc, refNo: newRef() })).toObject());
    } catch (e) {
      if (e?.code !== 11000 || attempt >= 3) throw e; // a reference number was taken: try another
    }
  }
}

const byToken = (token) => (/^[\w-]{10,40}$/.test(String(token || '')) ? { token } : null);

/** The visitor changed their proposal (they hold its link): the same proposal is kept up to date. */
export async function updateFreeProposal(token, body = {}, meta = {}) {
  const where = byToken(token);
  const clean = cleanProposal(body);
  const m = visitorMeta(body, meta);
  // a position is only replaced by another one: editing without sharing it again keeps the first
  const set = { ...clean, ...leadFields(clean), device: m.device, 'location.ip': m.location.ip, 'location.timezone': m.location.timezone, ...(m.location.lat != null && { location: m.location }) };
  if (m.location.lat != null) { delete set['location.ip']; delete set['location.timezone']; }
  const row = where ? await FreeProposal.findOneAndUpdate(where, { $set: set, ...(body.downloaded ? { $inc: { downloads: 1 } } : {}) }, { returnDocument: 'after' }).lean() : null;
  if (!row) throw notFound('Proposal');
  return visitorView(row);
}

/** The visitor's own proposal, opened again from its link. */
export async function getFreeProposal(token) {
  const where = byToken(token);
  const row = where ? await FreeProposal.findOne(where).lean() : null;
  if (!row) throw notFound('Proposal');
  return visitorView(row);
}

/* ───────────── platform admin ───────────── */

/** Every free proposal, newest first. The list leaves the logo out (it is heavy); one proposal carries it. */
export async function listFreeProposals() {
  return toApiJSONList(await FreeProposal.find({}).select('-logo').sort({ createdAt: -1 }).limit(1000).lean());
}

export async function adminGetFreeProposal(id) {
  const row = await FreeProposal.findById(objectId(id, 'Free proposal')).lean();
  if (!row) throw notFound('Free proposal');
  return toApiJSON(row);
}

export const countNewFreeProposals = () => FreeProposal.countDocuments({ status: 'new' });

export async function adminUpdateFreeProposal(id, body = {}) {
  const set = {};
  if (body.status !== undefined) {
    if (!FREE_PROPOSAL_STATUS.includes(body.status)) throw badRequest('Unknown status');
    set.status = body.status;
  }
  if (body.adminNotes !== undefined) set.adminNotes = clip(body.adminNotes, 2000);
  const row = await FreeProposal.findByIdAndUpdate(objectId(id, 'Free proposal'), { $set: set }, { returnDocument: 'after' }).select('-logo').lean();
  if (!row) throw notFound('Free proposal');
  return toApiJSON(row);
}

export async function removeFreeProposal(id) {
  const row = await FreeProposal.findByIdAndDelete(objectId(id, 'Free proposal'));
  if (!row) throw notFound('Free proposal');
  return { ok: true };
}
