import { Client, Design } from '../models/index.js';
import { forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { email as validEmail, objectId } from '../utils/validators.js';

const FIELDS = ['name', 'phone', 'address', 'notes'];

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

export async function createClient(company, body) {
  const max = company.limits.maxClients;
  if (max && (await Client.countDocuments({ company: company._id })) >= max) throw forbidden(`Your plan allows up to ${max} clients. Contact the platform administrator to raise the limit.`);
  const client = await Client.create({ ...pick(body, FIELDS), email: validEmail(body?.email, { required: false }), company: company._id });
  return { ...client.toJSON(), designs: 0 };
}

export async function updateClient(company, id, body) {
  const client = await getClient(company, id);
  Object.assign(client, pick(body, FIELDS));
  if (body?.email !== undefined) client.email = validEmail(body.email, { required: false });
  await client.save();
  return client;
}

/** Deleting a client also deletes the designs made for them. */
export async function deleteClient(company, id) {
  const client = await getClient(company, id);
  await Design.deleteMany({ company: company._id, client: client._id });
  await client.deleteOne();
}
