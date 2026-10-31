// Loans: a proposal sold on a loan (Design.loanRequired) gets one Loan, which starts with a copy of the company's
// loan step template (Company.loanSteps). The company moves it through those steps; the client sees the loans of
// their own proposals in the portal (even while the proposal is a draft), never the private notes or the log.
import path from 'node:path';
import { Client, Design, Loan } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { monthlyEmi } from '../utils/emi.js';
import { escapeRe } from '../utils/listFilters.js';
import { objectId } from '../utils/validators.js';
import { deleteFile } from './storage.service.js';

const CLIENT_FIELDS = 'name email phone address';
const DESIGN_FIELDS = 'name type status summary.kwp summary.address';

function appendLog(loan, user, action, stepName = '', message = '') {
  loan.logs.push({
    action,
    stepName,
    by: user?._id || null,
    byName: user?.name || user?.email || 'System',
    byRole: user?.role || '',
    message: String(message || '').trim().slice(0, 1000),
  });
}

export const MAX_STEP_DOCUMENTS = 20;

const fileOf = (doc) => String(doc.url).replace(/^\/uploads\//, '');
const documentFiles = (loans) => loans.flatMap((l) => l.steps.flatMap((s) => (s.documents || []).map(fileOf)));
const deleteFiles = (names) => Promise.all(names.map((n) => deleteFile(n).catch(() => {})));

const templateSteps = (company) => (company.loanSteps || []).map((s) => ({ name: s.name, description: s.description }));

/* ───────────── template ───────────── */

/** The loan step template. Replaced as a whole; loans already open keep the steps they started with. */
export async function updateLoanSteps(company, body) {
  company.loanSteps = body.steps.map((s) => ({ name: String(s.name).trim(), description: s.description || '' }));
  await company.save();
  return company.loanSteps;
}

/* ───────────── following the proposal ───────────── */

/** Opens the proposal's loan (once) with the company's current steps. Safe to call again. */
export async function openLoanForDesign(company, design, user) {
  const scope = { company: company._id, design: design._id };
  const existing = await Loan.findOne(scope);
  if (existing) return existing;
  const loan = new Loan({ ...scope, client: design.client?._id ?? design.client, steps: templateSteps(company), logs: [] });
  appendLog(loan, user, 'opened');
  try {
    await loan.save();
  } catch (e) {
    if (e?.code === 11000) return Loan.findOne(scope); // opened by a parallel request
    throw e;
  }
  return loan;
}

/** The proposal is no longer on a loan: removes it, unless work on it has already started. */
export async function closeLoanForDesign(company, design) {
  const loan = await Loan.findOne({ company: company._id, design: design._id });
  if (!loan) return;
  if (loan.steps.some((s) => s.status !== 'pending' || s.documents?.length) || loan.lender || loan.amount) {
    throw badRequest('This proposal’s loan is already being processed. Mark it as rejected under Loans instead of turning the loan option off.');
  }
  await loan.deleteOne();
}

/** The proposal moved to another client: the loan (and who sees it in the portal) goes with it. */
export async function moveLoanOfDesign(design) {
  await Loan.updateMany({ design: design._id }, { client: design.client?._id ?? design.client });
}

export async function deleteLoanOfDesign(designId) {
  const loans = await Loan.find({ design: designId }).select('steps.documents');
  await Loan.deleteMany({ design: designId });
  await deleteFiles(documentFiles(loans));
}

/* ───────────── company workspace ───────────── */

/** Every loan with its proposal and client; optional `q` (client name / phone / email, proposal name, lender) and `status`. */
export async function listLoans(company, { q, status } = {}) {
  const match = { company: company._id };
  if (status && status !== 'all') match.status = String(status);
  const term = String(q ?? '').trim().slice(0, 100);
  if (term) {
    const re = { $regex: escapeRe(term), $options: 'i' };
    const [clients, designs] = await Promise.all([
      Client.find({ company: company._id, $or: [{ name: re }, { phone: re }, { email: re }] }).select('_id'),
      Design.find({ company: company._id, name: re }).select('_id'),
    ]);
    match.$or = [{ client: { $in: clients.map((c) => c._id) } }, { design: { $in: designs.map((d) => d._id) } }, { lender: re }];
  }
  const loans = await Loan.find(match).select('-logs').sort({ updatedAt: -1 }).limit(1000).populate('client', CLIENT_FIELDS).populate('design', DESIGN_FIELDS);
  return loans.map((l) => l.toJSON());
}

export async function getLoanDoc(company, id) {
  const loan = await Loan.findOne({ _id: objectId(id, 'Loan'), company: company._id });
  if (!loan) throw notFound('Loan');
  return loan;
}

async function view(loan) {
  await loan.populate([{ path: 'client', select: CLIENT_FIELDS }, { path: 'design', select: DESIGN_FIELDS }]);
  return loan.toJSON();
}

export async function getLoan(company, id) {
  return view(await getLoanDoc(company, id));
}

/** The loan of one proposal (null when it has none), for the proposal's page. */
export async function getLoanOfDesign(company, designId) {
  const loan = await Loan.findOne({ company: company._id, design: objectId(designId, 'Proposal') }).select('-logs');
  return loan ? loan.toJSON() : null;
}

/** Lender, amount, private notes and the overall status. */
export async function updateLoan(company, user, id, body) {
  const loan = await getLoanDoc(company, id);
  for (const key of ['lender', 'branch', 'accountRef', 'notes']) if (body[key] !== undefined) loan[key] = body[key];
  if (body.ifsc !== undefined) loan.ifsc = String(body.ifsc || '').trim().toUpperCase();
  for (const key of ['amount', 'interestRate', 'tenureMonths', 'emi', 'downPayment', 'processingFee']) if (body[key] !== undefined) loan[key] = body[key];
  // the amount, rate or period changed and no EMI came with it (and none is stored): work it out. An EMI that is sent, even a
  // blank one, or already stored is kept as it is.
  if (body.emi === undefined && !(loan.emi > 0) && ['amount', 'interestRate', 'tenureMonths'].some((k) => body[k] !== undefined)) loan.emi = monthlyEmi(loan.amount, loan.interestRate, loan.tenureMonths) || null;
  for (const key of ['sanctionedOn', 'disbursedOn']) {
    if (body[key] === undefined) continue;
    const d = body[key] ? new Date(body[key]) : null;
    loan[key] = d && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (body.status && body.status !== loan.status) {
    loan.status = body.status;
    appendLog(loan, user, 'status_changed', '', body.status);
  }
  await loan.save();
  return view(loan);
}

/** One step's status and the remark the client sees. Finishing the last step completes the loan; reopening one reopens it. */
export async function updateLoanStep(company, user, id, stepId, body) {
  const loan = await getLoanDoc(company, id);
  const step = loan.steps.id(objectId(stepId, 'Step'));
  if (!step) throw notFound('Step');
  if (body.remark !== undefined) step.remark = body.remark;
  if (body.status && body.status !== step.status) {
    step.status = body.status;
    step.completedAt = body.status === 'done' ? new Date() : null;
    appendLog(loan, user, `step_${body.status}`, step.name);
    const allDone = loan.steps.every((s) => s.status === 'done');
    if (allDone && loan.status === 'in_progress') {
      loan.status = 'completed';
      appendLog(loan, user, 'status_changed', '', 'completed');
    } else if (!allDone && loan.status === 'completed') {
      loan.status = 'in_progress';
      appendLog(loan, user, 'status_changed', '', 'in_progress');
    }
  }
  await loan.save();
  return view(loan);
}

/** Keeps a file with a loan step (it is already stored by uploadLoanDocument); on any failure the stored file is removed. */
export async function addStepDocument(company, user, id, stepId, file) {
  if (!file?.filename) throw badRequest('Choose a file to upload');
  let loan;
  try {
    loan = await getLoanDoc(company, id);
    const step = loan.steps.id(objectId(stepId, 'Step'));
    if (!step) throw notFound('Step');
    if (step.documents.length >= MAX_STEP_DOCUMENTS) throw badRequest(`A step can keep up to ${MAX_STEP_DOCUMENTS} documents. Remove one first`);
    const name = String(file.originalname || '').trim().slice(0, 200) || 'Document';
    step.documents.push({ name, url: `/uploads/${file.filename}`, size: file.size, byName: user?.name || user?.email || '' });
    appendLog(loan, user, 'document_added', step.name, name);
    await loan.save();
  } catch (e) {
    await deleteFile(file.filename).catch(() => {}); // not kept: don't leave the stored file behind
    throw e;
  }
  return view(loan);
}

/** Gives a step document a new name; the file's own extension is kept on it (it is what the file opens as). */
export async function renameStepDocument(company, user, id, stepId, docId, name) {
  const loan = await getLoanDoc(company, id);
  const step = loan.steps.id(objectId(stepId, 'Step'));
  const doc = step?.documents.id(objectId(docId, 'Document'));
  if (!doc) throw notFound('Document');
  const ext = path.extname(doc.url).toLowerCase();
  let next = String(name || '').trim();
  if (ext && !next.toLowerCase().endsWith(ext)) next = `${next.slice(0, 200 - ext.length)}${ext}`;
  if (next !== doc.name) {
    appendLog(loan, user, 'document_renamed', step.name, `${doc.name} → ${next}`);
    doc.name = next;
    await loan.save();
  }
  return view(loan);
}

export async function removeStepDocument(company, user, id, stepId, docId) {
  const loan = await getLoanDoc(company, id);
  const step = loan.steps.id(objectId(stepId, 'Step'));
  const doc = step?.documents.id(objectId(docId, 'Document'));
  if (!doc) throw notFound('Document');
  const filename = fileOf(doc);
  appendLog(loan, user, 'document_removed', step.name, doc.name);
  doc.deleteOne();
  await loan.save();
  await deleteFile(filename).catch(() => {});
  return view(loan);
}

/** Adds the template steps this loan doesn't have yet (by name), e.g. after the template was changed. */
export async function syncLoanSteps(company, user, id) {
  const loan = await getLoanDoc(company, id);
  const have = new Set(loan.steps.map((s) => s.name.toLowerCase()));
  const missing = templateSteps(company).filter((s) => !have.has(s.name.toLowerCase()));
  if (!missing.length) throw badRequest('This loan already has every step of your template');
  loan.steps.push(...missing);
  if (loan.status === 'completed') loan.status = 'in_progress';
  appendLog(loan, user, 'steps_added', '', missing.map((s) => s.name).join(', '));
  await loan.save();
  return view(loan);
}

/* ───────────── client portal ───────────── */

/**
 * The signed-in client's loans, without notes or log. A loan is often arranged before the proposal is sent, so loans
 * on draft proposals show too — but `proposal.shared` is false for those, as the portal doesn't open drafts.
 */
export async function listMyLoans(user) {
  const loans = await Loan.find({ company: user.company, client: user.client }).select('-notes -logs').sort({ createdAt: -1 });
  if (!loans.length) return [];
  const designs = await Design.find({ company: user.company, client: user.client, _id: { $in: loans.map((l) => l.design) } }).select('name status');
  const byId = new Map(designs.map((d) => [d.id, d]));
  return loans.filter((l) => byId.has(String(l.design))).map((l) => {
    const d = byId.get(String(l.design));
    const { id, status, lender, amount, steps, createdAt, updatedAt } = l.toJSON();
    const publicSteps = steps.map(({ documents, ...s }) => s); // the step documents stay with the company
    return { id, proposal: { id: d.id, name: d.name, shared: d.status !== 'draft' }, status, lender, amount, steps: publicSteps, createdAt, updatedAt };
  });
}
