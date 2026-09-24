// Designs a company creates for its clients. `data` is the designer's saved state.
import { Client, Design } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';
import { deleteProjectsOf, moveDesignProject } from './project.service.js';

const SUMMARY = ['address', 'kwp', 'panels', 'cost', 'annualKwh'];
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

/** Lists leave out the heavy `data`. */
export function listDesigns(company, { client } = {}) {
  const filter = { company: company._id };
  if (client) filter.client = objectId(client, 'Client');
  return Design.find(filter).select('-data').populate('client', 'name email').sort({ updatedAt: -1 });
}

export async function createDesign(company, user, body) {
  const afterInsert = await checkLimit(company);
  const client = await ownClient(company, body?.client);
  const initialData = (body?.pricingMode || body?.packageId || body?.floorPlacement !== undefined)
    ? {
        config: {
          pricingMode: body.pricingMode || 'custom',
          packageId: body.packageId || '',
          floorPlacement: Number(body.floorPlacement) || 0,
          floorCost: Number(body.floorCost) || 0,
        },
      }
    : null;
  const name = String(body?.name || '').trim() || `${client.name} – rooftop solar`;
  const design = await Design.create({
    company: company._id,
    client: client._id,
    name,
    data: initialData,
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
  if (body?.client !== undefined) {
    design.client = (await ownClient(company, body.client))._id;
    await moveDesignProject(design);
    appendLog(design, user, 'design_client_changed', 'Client updated');
  }
  if (body?.status !== undefined && body.status !== prevStatus) {
    appendLog(design, user, 'design_status_changed', `${prevStatus} → ${body.status}`);
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
    if (body?.data === undefined && shouldLogDesignSave(design)) appendLog(design, user, 'design_updated', 'Design summary updated');
  }
  await design.save();
  // the designer autosaves often — don't echo the whole document back
  return { id: design.id, name: design.name, status: design.status, updatedAt: design.updatedAt };
}

export async function duplicateDesign(company, user, id) {
  const afterInsert = await checkLimit(company);
  const src = await getDesign(company, id);
  const copyName = `${src.name} (copy)`.slice(0, 120);
  const copy = await Design.create({ company: src.company, client: src.client._id, name: copyName, data: src.data, summary: src.summary, logs: [] });
  await afterInsert(copy);
  appendLog(copy, user, 'design_created', copyName);
  appendLog(copy, user, 'design_duplicated', `Copied from “${src.name}”`);
  await copy.save();
  return copy.populate('client', 'name email');
}

/** Deleting a design also deletes its installation. */
export async function deleteDesign(company, id) {
  const design = await getDesign(company, id);
  await deleteProjectsOf({ design: design._id });
  await design.deleteOne();
}
