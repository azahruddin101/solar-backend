// The public proposal page: what anyone holding the share link (or scanning its QR code) may see. Read-only, no sign-in.
// Only what a prospect needs: the price breakdown, the system, the validity and the company's contact details.
// Never the client's phone, email or address, payments, notes, or anything about other proposals.
import { Company, Design } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { totalOf } from './billing.service.js';
import { viewerCatalogFor } from './portal.service.js';

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

async function byToken(token, select = '-logs -data') {
  if (!TOKEN.test(String(token || ''))) throw notFound('Proposal');
  const design = await Design.findOne({ shareToken: token }).select(select).populate('client', 'name');
  if (!design) throw notFound('Proposal');
  return design;
}

async function companyOf(design) {
  const c = await Company.findById(design.company).select('name logo phone email address website tagline theme currency status');
  if (!c || c.status !== 'active') throw notFound('Proposal');
  const j = c.toJSON();
  return { name: j.name, logo: j.logo, phone: j.phone, email: j.email, address: j.address, website: j.website, tagline: j.tagline, theme: j.theme, currency: j.currency };
}

export async function proposal(token) {
  const design = await byToken(token, '-logs');
  const company = await companyOf(design);
  const validUntil = design.validUntil || null;
  return {
    company,
    client: { name: design.client?.name || '' },
    proposal: {
      name: design.name,
      type: design.type,
      status: design.status,
      createdAt: design.createdAt,
      validUntil,
      expired: Boolean(validUntil && new Date(validUntil) < new Date()),
      summary: { address: design.summary?.address, kwp: design.summary?.kwp, panels: design.summary?.panels, annualKwh: design.summary?.annualKwh },
      pricing: design.summary?.pricing || null,
      total: totalOf(design),
      hasDesign: design.type !== 'quick' && Boolean(design.data?.sections?.length),
    },
  };
}

export async function designData(token) {
  const design = await byToken(token, '-logs');
  if (design.type === 'quick' || !design.data?.sections?.length) throw badRequest('This proposal has no 3D design');
  return {
    id: 'public',
    name: design.name,
    status: design.status,
    data: design.data,
    summary: { address: design.summary?.address, kwp: design.summary?.kwp, panels: design.summary?.panels, annualKwh: design.summary?.annualKwh },
    client: { name: design.client?.name || '' },
    company: await companyOf(design),
  };
}

export async function catalog(token) {
  const design = await byToken(token);
  return viewerCatalogFor(design.company);
}

/** Satellite imagery for the 3D view: only near this proposal's site (about 2 km), and only while the link is on. */
export async function assertMapAllowed(token, lat, lng) {
  const design = await byToken(token, 'data.origin');
  const o = design.data?.origin;
  if (!o || !(Math.abs(o.lat - lat) < 0.02 && Math.abs(o.lng - lng) < 0.02)) throw notFound('Location');
}
