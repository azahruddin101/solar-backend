import crypto from 'node:crypto';
import { ROLES } from '../constants/index.js';
import { Client, Design, User } from '../models/index.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/HttpError.js';
import { hashPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { email as validEmail, objectId } from '../utils/validators.js';
import { deleteProjectsOf } from './project.service.js';
import { revokeUserSessions } from './session.service.js';
import { parsePagination, toApiJSONList } from '../utils/lean.js';

const FIELDS = ['name', 'phone', 'pan', 'gstNumber', 'projectType', 'roofType', 'address', 'notes', 'consumerNumber', 'source'];

function sanitizeClientInput(body) {
  const data = pick(body, FIELDS);
  if (data.projectType === 'residential') data.gstNumber = ''; // no GST for residential clients
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

export async function getClientView(company, id) {
  const client = await getClient(company, id);
  return { ...client.toJSON(), hasLogin: (await clientsWithLogin(company, client._id)).has(client.id) };
}

/** A readable password without look-alike characters (no 0/O, 1/l/I): shown once to the company to hand over. */
function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length }, () => chars[crypto.randomInt(chars.length)]).join('');
}

/**
 * Creates the client's sign-in (their email + a generated password), or — when one exists — resets its password and
 * turns it back on. The password is returned once; only its hash is stored.
 */
export async function provisionClientLogin(company, id) {
  const client = await getClient(company, id);
  const email = String(client.email || '').trim().toLowerCase();
  if (!email) throw badRequest("Add the client's email address first — it is their sign-in name");
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  let user = await User.findOne({ company: company._id, role: ROLES.CLIENT, client: client._id });
  if (user) {
    if (user.email !== email && (await User.exists({ email, _id: { $ne: user._id } }))) throw conflict('That email is already used by another account');
    Object.assign(user, { email, passwordHash, active: true, name: client.name, tokenVersion: (user.tokenVersion || 0) + 1 });
    await user.save();
    await revokeUserSessions(user._id);
  } else {
    if (await User.exists({ email })) throw conflict('That email is already used by another account, so a login cannot be created for it');
    user = await User.create({ email, passwordHash, role: ROLES.CLIENT, name: client.name, company: company._id, client: client._id, phone: client.phone || '' });
  }
  return { email, password };
}

/** Takes the client's access away (their records stay). */
export async function removeClientLogin(company, id) {
  const client = await getClient(company, id);
  const users = await User.find({ company: company._id, role: ROLES.CLIENT, client: client._id });
  for (const u of users) {
    await revokeUserSessions(u._id);
    await u.deleteOne();
  }
}

/** Ids of the company's clients that have a sign-in. */
async function clientsWithLogin(company, clientId = null) {
  const users = await User.find({ company: company._id, role: ROLES.CLIENT, ...(clientId ? { client: clientId } : {}) }).select('client');
  return new Set(users.map((u) => String(u.client)));
}

/** Paginated: pass `page`/`limit` (defaults to a single bounded page). */
export async function listClients(company, { page, limit } = {}) {
  const filter = { company: company._id };
  const { page: p, limit: l, skip } = parsePagination({ page, limit });
  const [clients, total] = await Promise.all([
    Client.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
    Client.countDocuments(filter),
  ]);
  const ids = clients.map((c) => c._id);
  const [counts, logins] = await Promise.all([
    Design.aggregate([{ $match: { company: company._id, client: { $in: ids } } }, { $group: { _id: '$client', n: { $sum: 1 } } }]),
    clientsWithLogin(company),
  ]);
  const designs = new Map(counts.map((c) => [String(c._id), c.n]));
  const items = toApiJSONList(clients).map((c) => ({ ...c, designs: designs.get(c.id) || 0, hasLogin: logins.has(c.id) }));
  return { items, total, page: p, limit: l };
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
  const result = { ...client.toJSON(), designs: 0, hasLogin: false };
  // every client with an email gets a sign-in so they can follow their proposals (view only)
  if (body?.createLogin !== false && client.email) {
    try {
      result.credentials = await provisionClientLogin(company, client.id);
      result.hasLogin = true;
    } catch (e) {
      result.loginError = e.message;
    }
  }
  return result;
}

export async function updateClient(company, id, body) {
  const client = await getClient(company, id);
  Object.assign(client, sanitizeClientInput(body));
  if (body?.email !== undefined) client.email = validEmail(body.email, { required: false });
  // the sign-in name follows the client's email
  const login = await User.findOne({ company: company._id, role: ROLES.CLIENT, client: client._id });
  if (login) {
    if (!client.email) throw badRequest("This client has a sign-in, so their email cannot be removed. Remove the sign-in first.");
    if (login.email !== client.email) {
      if (await User.exists({ email: client.email, _id: { $ne: login._id } })) throw conflict('That email is already used by another account');
      login.email = client.email;
      login.tokenVersion = (login.tokenVersion || 0) + 1;
      await login.save();
      await revokeUserSessions(login._id);
    }
    if (body?.name !== undefined) await User.updateOne({ _id: login._id }, { name: client.name });
  }
  await client.save();
  return { ...client.toJSON(), hasLogin: Boolean(login) };
}

/** Deleting a client also deletes the designs (and installations) made for them. */
export async function deleteClient(company, id) {
  const client = await getClient(company, id);
  await deleteProjectsOf({ company: company._id, client: client._id });
  await Design.deleteMany({ company: company._id, client: client._id });
  await removeClientLogin(company, client.id);
  await client.deleteOne();
}
