// Who may open which uploaded file. Branding images and avatars are public (the PDF generator and every screen
// load them directly); client documents, installation photos and ticket attachments are protected: they open only
// through a short-lived signed link that a signed-in, authorised user asks the API for.
import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';
import { hasPermission } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { ClientTicket, Ticket } from '../models/index.js';
import { forbidden, notFound } from '../utils/HttpError.js';

export const SAFE_NAME = /^[\w][\w.-]{0,200}$/;
export const LINK_TTL_MS = 10 * 60 * 1000;
/** Signed links sent to clients (e.g. WhatsApp) stay valid long enough to open later. */
export const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DOC = /^[0-9a-f]{24}-doc-/; // client documents:   <companyId>-doc-…
const STEP = /^[0-9a-f]{24}-step-/; // installation photos: <companyId>-step-…
const TICKET = /^ticket-/; // support attachments (company ↔ platform): ticket-…
const CLIENT_TICKET = /^cticket-/; // client support attachments (company ↔ client): cticket-…
const DESIGN_VERSION = /^[0-9a-f]{24}-design-/; // archived quotation PDFs: <companyId>-design-<designId>-v-…
const INVOICE_PDF = /^[0-9a-f]{24}-invoice-/; // archived tax invoices: <companyId>-invoice-<invoiceId>-…
const RECEIPT_PDF = /^[0-9a-f]{24}-receipt-/; // payment receipts: <companyId>-receipt-<paymentId>-…
const PRODUCT_DOC = /^[0-9a-f]{24}-proddoc-/; // product PDFs: <companyId>-proddoc-<productId>-…

const STOCK_BILL = /^[0-9a-f]{24}-bill-/; // supplier bills: <companyId>-bill-<batchId>-…
const LOAN_DOC = /^[0-9a-f]{24}-loandoc-/; // loan step documents: <companyId>-loandoc-<loanId>-…

export const isProtected = (name) => LOAN_DOC.test(name) || STOCK_BILL.test(name) || DOC.test(name) || STEP.test(name) || TICKET.test(name) || CLIENT_TICKET.test(name) || DESIGN_VERSION.test(name) || INVOICE_PDF.test(name) || RECEIPT_PDF.test(name) || PRODUCT_DOC.test(name);

const key = () => crypto.createHash('sha256').update(`file-link:${env.jwtSecret}`).digest();
const mac = (name, exp) => crypto.createHmac('sha256', key()).update(`${name}.${exp}`).digest('hex');

export function signName(name, now = Date.now(), ttlMs = LINK_TTL_MS) {
  const exp = now + ttlMs;
  return { exp, sig: mac(name, exp) };
}

/** True when `sig` is the signature for this file and `exp` has not passed. */
export function validSignature(name, exp, sig, now = Date.now()) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now || typeof sig !== 'string') return false;
  const expected = Buffer.from(mac(name, e), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(expected, given);
}

/** Throws unless `user` may open the protected file `name`. */
export async function assertCanOpen(user, name) {
  // client support stays between the company and its client: checked before the platform admin's general access
  if (CLIENT_TICKET.test(name)) {
    const url = `/uploads/${name}`;
    const scope = user.role === ROLES.CLIENT
      ? (user.client ? { company: user.company, client: user.client } : null)
      : [ROLES.COMPANY, ROLES.AGENT].includes(user.role) && hasPermission(user, 'helpdesk', 'view') ? { company: user.company } : null;
    if (scope && (await ClientTicket.exists({ ...scope, 'messages.attachments.url': url }))) return;
    throw forbidden('You do not have access to this file');
  }
  if (user.role === ROLES.SUPERADMIN) return;
  const owner = name.slice(0, 24);
  const ownCompany = String(user.company) === owner;
  // the owner, or a staff member of the same company who may view the area the file belongs to
  const mayView = (area) => ownCompany && hasPermission(user, area, 'view');
  if (DOC.test(name)) {
    if (mayView('clients')) return;
  } else if (STEP.test(name)) {
    if (user.role !== ROLES.CLIENT && ownCompany) return; // the company's owner and its agents (never a client)
  } else if (TICKET.test(name)) {
    if (!mayView('support')) throw forbidden();
    const ticket = await Ticket.findOne({ company: user.company, 'messages.attachments.url': `/uploads/${name}` }).select('_id').lean();
    if (ticket) return;
  } else if (DESIGN_VERSION.test(name)) {
    if (mayView('proposals')) return;
  } else if (INVOICE_PDF.test(name) || RECEIPT_PDF.test(name)) {
    if (mayView('finances')) return;
  } else if (STOCK_BILL.test(name)) {
    if (['inventory', 'finances'].some(mayView)) return;
  } else if (LOAN_DOC.test(name)) {
    if (mayView('loans')) return;
  } else if (PRODUCT_DOC.test(name)) {
    // whoever may see the catalog's products (see catalog.routes.js)
    if (['proposals', 'inventory', 'finances', 'tasks'].some(mayView)) return;
  }
  throw forbidden('You do not have access to this file');
}

/** `url` is what the app stores: /uploads/<name>. Returns the same path with an expiry and signature. */
export async function linkFor(user, url) {
  const name = path.basename(String(url ?? ''));
  if (String(url ?? '') !== `/uploads/${name}` || !SAFE_NAME.test(name)) throw notFound('File'); // exactly /uploads/<name>
  if (!isProtected(name)) return { url: `/uploads/${name}` }; // public files need no link
  await assertCanOpen(user, name);
  const { exp, sig } = signName(name);
  return { url: `/uploads/${name}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp).toISOString() };
}
