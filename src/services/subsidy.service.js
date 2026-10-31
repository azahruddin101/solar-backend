// Subsidies: a proposal with a subsidy (Design.subsidy.enabled) gets one Subsidy, which starts with a copy of the company's
// subsidy step template (Company.subsidySteps). The company moves it through those steps; the client sees the subsidies of
// their own proposals in the portal (even while the proposal is a draft), never the private notes or the log.
import path from 'node:path';
import { Client, Design, Subsidy } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { escapeRe } from '../utils/listFilters.js';
import { objectId } from '../utils/validators.js';
import { deleteFile } from './storage.service.js';

const CLIENT_FIELDS = 'name email phone address';
const DESIGN_FIELDS = 'name type status summary.kwp summary.address';

function appendLog(subsidy, user, action, stepName = '', message = '') {
  subsidy.logs.push({
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
const documentFiles = (subsidies) => subsidies.flatMap((l) => l.steps.flatMap((s) => (s.documents || []).map(fileOf)));
const deleteFiles = (names) => Promise.all(names.map((n) => deleteFile(n).catch(() => {})));

const templateSteps = (company) => (company.subsidySteps || []).map((s) => ({ name: s.name, description: s.description }));

/* ───────────── template ───────────── */

/** The subsidy step template. Replaced as a whole; subsidies already open keep the steps they started with. */
export async function updateSubsidySteps(company, body) {
  company.subsidySteps = body.steps.map((s) => ({ name: String(s.name).trim(), description: s.description || '' }));
  await company.save();
  return company.subsidySteps;
}

/* ───────────── following the proposal ───────────── */

/** Opens the proposal's subsidy (once) with the company's current steps. Safe to call again. */
export async function openSubsidyForDesign(company, design, user) {
  const scope = { company: company._id, design: design._id };
  const existing = await Subsidy.findOne(scope);
  if (existing) return existing;
  const subsidy = new Subsidy({ ...scope, client: design.client?._id ?? design.client, centralAmount: design.subsidy?.central || null, stateAmount: design.subsidy?.state || null, steps: templateSteps(company), logs: [] });
  appendLog(subsidy, user, 'opened');
  try {
    await subsidy.save();
  } catch (e) {
    if (e?.code === 11000) return Subsidy.findOne(scope); // opened by a parallel request
    throw e;
  }
  return subsidy;
}

/** The proposal is no longer on a subsidy: removes it, unless work on it has already started. */
export async function closeSubsidyForDesign(company, design) {
  const subsidy = await Subsidy.findOne({ company: company._id, design: design._id });
  if (!subsidy) return;
  if (subsidy.steps.some((s) => s.status !== 'pending' || s.documents?.length) || subsidy.applicationNo || subsidy.receivedAmount) {
    throw badRequest('This proposal’s subsidy is already being processed. Mark it as rejected under Subsidies instead of turning the subsidy option off.');
  }
  await subsidy.deleteOne();
}

/** The proposal moved to another client: the subsidy (and who sees it in the portal) goes with it. */
export async function moveSubsidyOfDesign(design) {
  await Subsidy.updateMany({ design: design._id }, { client: design.client?._id ?? design.client });
}

export async function deleteSubsidyOfDesign(designId) {
  const subsidies = await Subsidy.find({ design: designId }).select('steps.documents');
  await Subsidy.deleteMany({ design: designId });
  await deleteFiles(documentFiles(subsidies));
}

/* ───────────── company workspace ───────────── */

/** Every subsidy with its proposal and client; optional `q` (client name / phone / email, proposal name, scheme, application or consumer number) and `status`. */
export async function listSubsidies(company, { q, status } = {}) {
  const match = { company: company._id };
  if (status && status !== 'all') match.status = String(status);
  const term = String(q ?? '').trim().slice(0, 100);
  if (term) {
    const re = { $regex: escapeRe(term), $options: 'i' };
    const [clients, designs] = await Promise.all([
      Client.find({ company: company._id, $or: [{ name: re }, { phone: re }, { email: re }] }).select('_id'),
      Design.find({ company: company._id, name: re }).select('_id'),
    ]);
    match.$or = [{ client: { $in: clients.map((c) => c._id) } }, { design: { $in: designs.map((d) => d._id) } }, { scheme: re }, { applicationNo: re }, { consumerNo: re }];
  }
  const subsidies = await Subsidy.find(match).select('-logs').sort({ updatedAt: -1 }).limit(1000).populate('client', CLIENT_FIELDS).populate('design', DESIGN_FIELDS);
  return subsidies.map((l) => l.toJSON());
}

export async function getSubsidyDoc(company, id) {
  const subsidy = await Subsidy.findOne({ _id: objectId(id, 'Subsidy'), company: company._id });
  if (!subsidy) throw notFound('Subsidy');
  return subsidy;
}

async function view(subsidy) {
  await subsidy.populate([{ path: 'client', select: CLIENT_FIELDS }, { path: 'design', select: DESIGN_FIELDS }]);
  return subsidy.toJSON();
}

export async function getSubsidy(company, id) {
  return view(await getSubsidyDoc(company, id));
}

/** The subsidy of one proposal (null when it has none), for the proposal's page. */
export async function getSubsidyOfDesign(company, designId) {
  const subsidy = await Subsidy.findOne({ company: company._id, design: objectId(designId, 'Proposal') }).select('-logs');
  return subsidy ? subsidy.toJSON() : null;
}

/** Scheme, application details, amounts, dates, private notes and the overall status. */
export async function updateSubsidy(company, user, id, body) {
  const subsidy = await getSubsidyDoc(company, id);
  for (const key of ['scheme', 'applicationNo', 'consumerNo', 'discom', 'notes']) if (body[key] !== undefined) subsidy[key] = body[key];
  for (const key of ['centralAmount', 'stateAmount', 'receivedAmount']) if (body[key] !== undefined) subsidy[key] = body[key];
  for (const key of ['approvedOn', 'creditedOn']) {
    if (body[key] === undefined) continue;
    const d = body[key] ? new Date(body[key]) : null;
    subsidy[key] = d && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (body.status && body.status !== subsidy.status) {
    subsidy.status = body.status;
    appendLog(subsidy, user, 'status_changed', '', body.status);
  }
  await subsidy.save();
  return view(subsidy);
}

/** One step's status and the remark the client sees. Finishing the last step completes the subsidy; reopening one reopens it. */
export async function updateSubsidyStep(company, user, id, stepId, body) {
  const subsidy = await getSubsidyDoc(company, id);
  const step = subsidy.steps.id(objectId(stepId, 'Step'));
  if (!step) throw notFound('Step');
  if (body.remark !== undefined) step.remark = body.remark;
  if (body.status && body.status !== step.status) {
    step.status = body.status;
    step.completedAt = body.status === 'done' ? new Date() : null;
    appendLog(subsidy, user, `step_${body.status}`, step.name);
    const allDone = subsidy.steps.every((s) => s.status === 'done');
    if (allDone && subsidy.status === 'in_progress') {
      subsidy.status = 'completed';
      appendLog(subsidy, user, 'status_changed', '', 'completed');
    } else if (!allDone && subsidy.status === 'completed') {
      subsidy.status = 'in_progress';
      appendLog(subsidy, user, 'status_changed', '', 'in_progress');
    }
  }
  await subsidy.save();
  return view(subsidy);
}

/** Keeps a file with a subsidy step (it is already stored by uploadSubsidyDocument); on any failure the stored file is removed. */
export async function addStepDocument(company, user, id, stepId, file) {
  if (!file?.filename) throw badRequest('Choose a file to upload');
  let subsidy;
  try {
    subsidy = await getSubsidyDoc(company, id);
    const step = subsidy.steps.id(objectId(stepId, 'Step'));
    if (!step) throw notFound('Step');
    if (step.documents.length >= MAX_STEP_DOCUMENTS) throw badRequest(`A step can keep up to ${MAX_STEP_DOCUMENTS} documents. Remove one first`);
    const name = String(file.originalname || '').trim().slice(0, 200) || 'Document';
    step.documents.push({ name, url: `/uploads/${file.filename}`, size: file.size, byName: user?.name || user?.email || '' });
    appendLog(subsidy, user, 'document_added', step.name, name);
    await subsidy.save();
  } catch (e) {
    await deleteFile(file.filename).catch(() => {}); // not kept: don't leave the stored file behind
    throw e;
  }
  return view(subsidy);
}

/** Gives a step document a new name; the file's own extension is kept on it (it is what the file opens as). */
export async function renameStepDocument(company, user, id, stepId, docId, name) {
  const subsidy = await getSubsidyDoc(company, id);
  const step = subsidy.steps.id(objectId(stepId, 'Step'));
  const doc = step?.documents.id(objectId(docId, 'Document'));
  if (!doc) throw notFound('Document');
  const ext = path.extname(doc.url).toLowerCase();
  let next = String(name || '').trim();
  if (ext && !next.toLowerCase().endsWith(ext)) next = `${next.slice(0, 200 - ext.length)}${ext}`;
  if (next !== doc.name) {
    appendLog(subsidy, user, 'document_renamed', step.name, `${doc.name} → ${next}`);
    doc.name = next;
    await subsidy.save();
  }
  return view(subsidy);
}

export async function removeStepDocument(company, user, id, stepId, docId) {
  const subsidy = await getSubsidyDoc(company, id);
  const step = subsidy.steps.id(objectId(stepId, 'Step'));
  const doc = step?.documents.id(objectId(docId, 'Document'));
  if (!doc) throw notFound('Document');
  const filename = fileOf(doc);
  appendLog(subsidy, user, 'document_removed', step.name, doc.name);
  doc.deleteOne();
  await subsidy.save();
  await deleteFile(filename).catch(() => {});
  return view(subsidy);
}

/** Adds the template steps this subsidy doesn't have yet (by name), e.g. after the template was changed. */
export async function syncSubsidySteps(company, user, id) {
  const subsidy = await getSubsidyDoc(company, id);
  const have = new Set(subsidy.steps.map((s) => s.name.toLowerCase()));
  const missing = templateSteps(company).filter((s) => !have.has(s.name.toLowerCase()));
  if (!missing.length) throw badRequest('This subsidy already has every step of your template');
  subsidy.steps.push(...missing);
  if (subsidy.status === 'completed') subsidy.status = 'in_progress';
  appendLog(subsidy, user, 'steps_added', '', missing.map((s) => s.name).join(', '));
  await subsidy.save();
  return view(subsidy);
}

/* ───────────── client portal ───────────── */

/**
 * The signed-in client's subsidies, without notes or log. A subsidy is often arranged before the proposal is sent, so subsidies
 * on draft proposals show too — but `proposal.shared` is false for those, as the portal doesn't open drafts.
 */
export async function listMySubsidies(user) {
  const subsidies = await Subsidy.find({ company: user.company, client: user.client }).select('-notes -logs').sort({ createdAt: -1 });
  if (!subsidies.length) return [];
  const designs = await Design.find({ company: user.company, client: user.client, _id: { $in: subsidies.map((l) => l.design) } }).select('name status');
  const byId = new Map(designs.map((d) => [d.id, d]));
  return subsidies.filter((l) => byId.has(String(l.design))).map((l) => {
    const d = byId.get(String(l.design));
    const { id, status, scheme, applicationNo, centralAmount, stateAmount, receivedAmount, steps, createdAt, updatedAt } = l.toJSON();
    const publicSteps = steps.map(({ documents, ...s }) => s); // the step documents stay with the company
    return { id, proposal: { id: d.id, name: d.name, shared: d.status !== 'draft' }, status, scheme, applicationNo, centralAmount, stateAmount, receivedAmount, steps: publicSteps, createdAt, updatedAt };
  });
}
