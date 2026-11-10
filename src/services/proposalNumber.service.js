// Proposal numbers: a company-chosen prefix, a running number and an optional suffix, e.g. PRO- + 0001 + /26-27 →
// PRO-0001/26-27. Same rules as invoice numbers (invoiceNumber.service.js): the running number lives on the company
// (`proposalNumbering.next`) and is reserved with an atomic $inc, so two proposals created at the same moment never get
// the same number; a number that already exists is skipped. A proposal keeps its number for good.
import { Company, Design } from '../models/index.js';
import { badRequest } from '../utils/HttpError.js';

export const DEFAULT_PROPOSAL_NUMBERING = { prefix: 'PRO-', suffix: '', width: 4, next: 1 };
const MAX_PART = 20;
const MAX_WIDTH = 10;
/** Letters, digits and - / _ . */
const PART_RE = /^[A-Za-z0-9/_.-]*$/;
const DIGITS_RE = /^\d{1,10}$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const settingsOf = (company) => ({ ...DEFAULT_PROPOSAL_NUMBERING, ...(company.proposalNumbering?.toObject?.() ?? company.proposalNumbering ?? {}) });

/** 7 with width 4 → "PRO-0007<suffix>"; the width is a minimum, so numbers never wrap. */
export const formatProposalNo = ({ prefix = '', suffix = '', width = 4 } = {}, seq) => `${prefix}${String(seq).padStart(width, '0')}${suffix}`;

/** The number the next proposal will get (nothing is reserved). */
export function peekProposalNo(company) {
  const n = settingsOf(company);
  return formatProposalNo(n, n.next ?? 1);
}

/** Highest running number already used with this prefix and suffix in the company, or 0. */
async function highestUsedSeq(company, prefix, suffix) {
  const rows = await Design.find({ company: company._id, proposalNo: new RegExp(`^${escapeRe(prefix)}\\d+${escapeRe(suffix)}$`) }).select('proposalNo').lean();
  let max = 0;
  for (const r of rows) {
    const seq = Number(r.proposalNo.slice(prefix.length, r.proposalNo.length - suffix.length));
    if (seq > max) max = seq;
  }
  return max;
}

/**
 * Settings input → stored numbering. `next` is typed with its leading zeros ("0001"): that fixes the width.
 * Refuses a start that would reuse a number already given under the same prefix and suffix.
 */
export async function parseProposalNumbering(company, input) {
  if (!input || typeof input !== 'object') throw badRequest('Invalid proposal numbering');
  const prefix = String(input.prefix ?? '').trim();
  const suffix = String(input.suffix ?? '').trim();
  const nextStr = String(input.next ?? '').trim();
  if (prefix.length > MAX_PART) throw badRequest(`The prefix can be at most ${MAX_PART} characters`);
  if (suffix.length > MAX_PART) throw badRequest(`The suffix can be at most ${MAX_PART} characters`);
  if (!PART_RE.test(prefix) || !PART_RE.test(suffix)) throw badRequest('The prefix and suffix can only have letters, digits and - / _ .');
  if (!DIGITS_RE.test(nextStr)) throw badRequest('Enter the next number as digits only, like 0001');
  const next = Number(nextStr);
  if (!(next >= 1)) throw badRequest('The next number must be at least 1');
  const width = Math.min(nextStr.length, MAX_WIDTH);
  const used = await highestUsedSeq(company, prefix, suffix);
  const fmt = (seq) => formatProposalNo({ prefix, suffix, width }, seq);
  if (next <= used) throw badRequest(`${fmt(next)} is already used. Numbers up to ${fmt(used)} exist, so start from ${fmt(used + 1)} or later`);
  return { prefix, suffix, width, next };
}

/** Atomically take the next free proposal number of `company`. */
export async function reserveProposalNo(company) {
  // companies saved before proposal numbering existed have no setting yet: start them on the defaults
  await Company.updateOne({ _id: company._id, 'proposalNumbering.next': { $not: { $type: 'number' } } }, { $set: { proposalNumbering: DEFAULT_PROPOSAL_NUMBERING } });
  for (let attempt = 0; attempt < 50; attempt++) {
    const before = await Company.findOneAndUpdate({ _id: company._id }, { $inc: { 'proposalNumbering.next': 1 } }, { returnDocument: 'before', projection: { proposalNumbering: 1 } }).lean();
    if (!before) throw badRequest('Company not found');
    const n = { ...DEFAULT_PROPOSAL_NUMBERING, ...(before.proposalNumbering || {}) };
    const no = formatProposalNo(n, n.next);
    if (!(await Design.exists({ company: company._id, proposalNo: no }))) return no;
  }
  throw badRequest('Could not find a free proposal number. Check the proposal numbering in Settings');
}
