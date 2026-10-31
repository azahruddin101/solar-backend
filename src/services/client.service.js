import crypto from 'node:crypto';
import { deleteClientTicketsForClient } from './clientTicket.service.js';
import { ROLES } from '../constants/index.js';
import { Bill, Client, Design, EwayBill, Invoice, Payment, Project, User } from '../models/index.js';
import { hasPermission } from '../middlewares/auth.middleware.js';
import { deleteDesign } from './design.service.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/HttpError.js';
import { hashPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { email as validEmail, objectId } from '../utils/validators.js';
import { deleteProjectsOf } from './project.service.js';
import { revokeUserSessions } from './session.service.js';
import { parsePagination, toApiJSONList } from '../utils/lean.js';
import { dateRangeOnField, escapeRe } from '../utils/listFilters.js';

const FIELDS = ['name', 'phone', 'pan', 'gstNumber', 'projectType', 'roofType', 'address', 'notes', 'consumerNumber', 'source'];

function clientListMatch(company, { q, from, to } = {}) {
  const match = { company: company._id };
  Object.assign(match, dateRangeOnField('createdAt', from, to) || {});
  const term = String(q ?? '').trim().slice(0, 100);
  if (term) {
    const re = escapeRe(term);
    match.$or = [
      { name: { $regex: re, $options: 'i' } },
      { email: { $regex: re, $options: 'i' } },
      { phone: { $regex: re, $options: 'i' } },
      { address: { $regex: re, $options: 'i' } },
      { consumerNumber: { $regex: re, $options: 'i' } },
      { source: { $regex: re, $options: 'i' } },
      { 'referredBy.name': { $regex: re, $options: 'i' } },
    ];
  }
  return match;
}

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

/** Paginated list; optional `q`, `from`/`to` (`YYYY-MM-DD`) filter by created date and search fields. */
export async function listClients(company, { page, limit, q, from, to } = {}) {
  const { page: p, limit: l, skip } = parsePagination({ page, limit });
  const match = clientListMatch(company, { q, from, to });
  const [facet] = await Client.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    {
      $facet: {
        meta: [{ $count: 'total' }],
        rows: [{ $skip: skip }, { $limit: l }],
      },
    },
  ]);
  const total = facet?.meta?.[0]?.total ?? 0;
  const clients = facet?.rows ?? [];
  const ids = clients.map((c) => c._id);
  const [counts, logins] = await Promise.all([
    ids.length
      ? Design.aggregate([{ $match: { company: company._id, client: { $in: ids } } }, { $group: { _id: '$client', n: { $sum: 1 } } }])
      : [],
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

/**
 * Deleting a client also deletes the proposals (and installations) made for them — but never money records or goods
 * taken from stock: a client with any e-way bill (not cancelled), bill or invoice can't be deleted. Because the delete reaches into proposals and installations,
 * a staff member also needs the delete permission of those areas when the client has any.
 */
export async function deleteClient(company, id, user) {
  const client = await getClient(company, id);
  const scope = { company: company._id, client: client._id };
  const designs = await Design.find(scope).select('_id').lean();
  const designIds = designs.map((d) => d._id);
  const ofClient = { $or: [{ client: client._id }, { design: { $in: designIds } }] };
  const billed = (await EwayBill.exists({ company: company._id, status: { $ne: 'cancelled' }, ...ofClient }))
    || (await Payment.exists({ company: company._id, ...ofClient }))
    || (await Bill.exists({ company: company._id, ...ofClient })) // a void bill is still a numbered document
    || (await Invoice.exists({ company: company._id, ...ofClient }));
  if (billed) throw badRequest('This client has e-way bills, bills or invoices, so it cannot be deleted. Cancel any open e-way bills first.');
  if (designIds.length && !hasPermission(user, 'proposals', 'delete')) {
    throw forbidden('This client has proposals. Deleting the client deletes them too, which needs the Proposals “Delete” permission.');
  }
  if (!hasPermission(user, 'tasks', 'delete') && (await Project.exists({ company: company._id, $or: [{ client: client._id }, { design: { $in: designIds } }] }))) {
    throw forbidden('This client has installations. Deleting the client deletes them too, which needs the Installations “Delete” permission.');
  }
  // one by one, so each proposal's stored PDF versions and installation go with it (and its own money check runs)
  for (const designId of designIds) await deleteDesign(company, designId);
  await deleteProjectsOf(scope);
  await deleteClientTicketsForClient(company._id, client._id);
  await removeClientLogin(company, client.id);
  await client.deleteOne();
}
