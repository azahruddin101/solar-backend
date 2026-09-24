import { Client, Design } from '../models/index.js';
import { forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { email as validEmail, objectId } from '../utils/validators.js';
import { deleteProjectsOf } from './project.service.js';

const FIELDS = ['name', 'phone', 'pan', 'address', 'notes', 'consumerNumber', 'source'];

function sanitizeClientInput(body) {
  const data = pick(body, FIELDS);
  if (body?.kwRequired !== undefined) {
    data.kwRequired = body.kwRequired === '' || body.kwRequired === null ? null : Number(body.kwRequired);
  }
  if (body?.referredBy && typeof body.referredBy === 'object') {
    data.referredBy = {
      name: body.referredBy.name ? String(body.referredBy.name).trim().slice(0, 120) : '',
      phone: body.referredBy.phone ? String(body.referredBy.phone).trim().slice(0, 40) : '',
    };
  }
  if (Array.isArray(body?.documents)) {
    data.documents = body.documents.map((d) => ({
      name: String(d.name || '').trim().slice(0, 200),
      url: String(d.url || '').trim().slice(0, 500),
      size: Number(d.size) || 0,
      mimetype: String(d.mimetype || '').trim().slice(0, 100),
      uploadedAt: d.uploadedAt ? new Date(d.uploadedAt) : new Date(),
    })).filter((d) => d.url);
  }
  return data;
}

export async function getClient(company, id) {
  const client = await Client.findOne({ _id: objectId(id, 'Client'), company: company._id });
  if (!client) throw notFound('Client');
  return client;
}

export async function listClients(company) {
  const [clients, counts] = await Promise.all([
    Client.find({ company: company._id }).sort({ createdAt: -1 }),
    Design.aggregate([{ $match: { company: company._id } }, { $group: { _id: '$client', n: { $sum: 1 } } }]),
  ]);
  const designs = new Map(counts.map((c) => [String(c._id), c.n]));
  return clients.map((c) => ({ ...c.toJSON(), designs: designs.get(c.id) || 0 }));
}

function appendClientLog(client, user, action, message = '') {
  if (!client.logs) client.logs = [];
  client.logs.push({
    action,
    by: user?._id || null,
    byName: user?.name || user?.email || 'System',
    byRole: user?.role || '',
    message: String(message || '').trim().slice(0, 1000),
  });
}

export async function createClient(company, user, body) {
  const { effectiveLimitsForCompany } = await import('./subscription.service.js');
  const max = (await effectiveLimitsForCompany(company)).maxClients;
  const limitMessage = `Your plan allows up to ${max} clients. Upgrade your plan or contact the platform administrator.`;
  if (!(max >= 1) || (await Client.countDocuments({ company: company._id })) >= max) throw forbidden(limitMessage);
  const name = String(body?.name ?? '').trim();
  const client = new Client({ ...sanitizeClientInput(body), email: validEmail(body?.email, { required: false }), company: company._id, logs: [] });
  appendClientLog(client, user, 'client_created', name);
  await client.save();
  // two requests can pass the check above at the same time; re-count after saving and undo this one if the limit was passed
  if ((await Client.countDocuments({ company: company._id })) > max) {
    await client.deleteOne();
    throw forbidden(limitMessage);
  }
  return { ...client.toJSON(), designs: 0 };
}

export async function updateClient(company, id, body) {
  const client = await getClient(company, id);
  Object.assign(client, sanitizeClientInput(body));
  if (body?.email !== undefined) client.email = validEmail(body.email, { required: false });
  await client.save();
  return client;
}

/** Deleting a client also deletes the designs (and installations) made for them. */
export async function deleteClient(company, id) {
  const client = await getClient(company, id);
  await deleteProjectsOf({ company: company._id, client: client._id });
  await Design.deleteMany({ company: company._id, client: client._id });
  await client.deleteOne();
}
