// Designs a company creates for its clients. `data` is the designer's saved state.
import { Client, Design } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';

const SUMMARY = ['address', 'kwp', 'panels', 'cost', 'annualKwh'];

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
  const max = company.limits.maxDesigns;
  if (max && (await Design.countDocuments({ company: company._id })) >= max) throw forbidden(`Your plan allows up to ${max} designs. Contact the platform administrator to raise the limit.`);
}

/** Lists leave out the heavy `data`. */
export function listDesigns(company, { client } = {}) {
  const filter = { company: company._id };
  if (client) filter.client = objectId(client, 'Client');
  return Design.find(filter).select('-data').populate('client', 'name email').sort({ updatedAt: -1 });
}

export async function createDesign(company, body) {
  await checkLimit(company);
  const client = await ownClient(company, body?.client);
  const design = await Design.create({ company: company._id, client: client._id, name: String(body?.name || '').trim() || `${client.name} – rooftop solar` });
  return design.populate('client');
}

export async function updateDesign(company, id, body) {
  const design = await getDesign(company, id);
  Object.assign(design, pick(body, ['name', 'status']));
  if (body?.client !== undefined) design.client = (await ownClient(company, body.client))._id;
  if (body?.data !== undefined) {
    if (body.data !== null && typeof body.data !== 'object') throw badRequest('Invalid design data');
    design.data = body.data;
    design.markModified('data');
  }
  if (body?.summary) Object.assign(design.summary, pick(body.summary, SUMMARY));
  await design.save();
  // the designer autosaves often — don't echo the whole document back
  return { id: design.id, name: design.name, status: design.status, updatedAt: design.updatedAt };
}

export async function duplicateDesign(company, id) {
  await checkLimit(company);
  const src = await getDesign(company, id);
  const copy = await Design.create({ company: src.company, client: src.client._id, name: `${src.name} (copy)`.slice(0, 120), data: src.data, summary: src.summary });
  return copy.populate('client', 'name email');
}

export async function deleteDesign(company, id) {
  await (await getDesign(company, id)).deleteOne();
}
