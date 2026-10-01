import { InstallationCharge } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';

const FIELDS = ['name', 'description', 'defaultPrice', 'gstPercent'];
const MAX_CHARGES = 100;
const collation = { locale: 'en', strength: 2 };

function clean(body) {
  const data = pick(body, FIELDS);
  if (!String(data.name ?? '').trim()) throw badRequest('Charge name is required');
  if (data.defaultPrice !== undefined) data.defaultPrice = Math.max(0, Number(data.defaultPrice) || 0);
  if (data.gstPercent !== undefined) data.gstPercent = Math.max(0, Math.min(100, Number(data.gstPercent ?? 18) || 18));
  return data;
}

async function assertUnique(company, name, exceptId) {
  const dup = await InstallationCharge.findOne({ company: company._id, name: String(name).trim(), ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).collation(collation);
  if (dup) throw badRequest('You already have an installation charge with this name');
}

export const installationChargeService = {
  list: (company) => InstallationCharge.find({ company: company._id }).sort({ name: 1 }).collation(collation),

  async create(company, body) {
    const data = clean(body);
    if ((await InstallationCharge.countDocuments({ company: company._id })) >= MAX_CHARGES) throw badRequest(`You can add up to ${MAX_CHARGES} installation charges`);
    await assertUnique(company, data.name);
    return InstallationCharge.create({ ...data, company: company._id });
  },

  async update(company, id, body) {
    const doc = await InstallationCharge.findOne({ _id: objectId(id, 'Installation charge'), company: company._id });
    if (!doc) throw notFound('Installation charge');
    const data = clean(body);
    await assertUnique(company, data.name, doc._id);
    Object.assign(doc, data);
    return doc.save();
  },

  async remove(company, id) {
    const doc = await InstallationCharge.findOneAndDelete({ _id: objectId(id, 'Installation charge'), company: company._id });
    if (!doc) throw notFound('Installation charge');
    return { ok: true };
  },
};
