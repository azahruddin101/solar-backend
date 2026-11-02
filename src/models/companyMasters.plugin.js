// A branch (Company) always reads its organization's shared settings ("masters": branding, PDF terms, pricing, the
// installation / AMC / loan / subsidy templates, units, job titles, the lead form, features).
//
// The organization document is the only source of truth for those fields. Branch documents may still hold an old copy
// (from before organizations existed) or the schema defaults; neither may ever be read. Doing the overlay here, on
// every Company query, means no code path can forget it - `Company.findById(...)`, `.select('amcTemplates')`, `.lean()`,
// inside a transaction or not. Values applied this way are not marked modified, so saving a branch never writes the
// organization's settings back onto it.
//
// Escape hatch for code that must see the branch's own stored copy (migrations): `.setOptions({ rawBranch: true })`.
import mongoose from 'mongoose';
import { MASTER_FIELD_KEYS } from './organizationMasters.schema.js';

export const SHARED_KEYS = [...MASTER_FIELD_KEYS, 'features'];

const hasKey = (projection, key) => Object.keys(projection).some((p) => p === key || p.startsWith(`${key}.`));

/** Which shared keys this query returns, from its projection (none, inclusive or exclusive). */
function sharedKeysOf(query) {
  const projection = query.projection() || {};
  const fields = Object.entries(projection).filter(([k]) => k !== '_id');
  if (!fields.length) return { keys: SHARED_KEYS, inclusive: false };
  const inclusive = fields.some(([, v]) => v === 1 || v === true || (v && typeof v === 'object'));
  if (inclusive) return { keys: SHARED_KEYS.filter((k) => hasKey(projection, k)), inclusive: true };
  return { keys: SHARED_KEYS.filter((k) => !(projection[k] === 0 || projection[k] === false)), inclusive: false };
}

function prepare() {
  if (this.getOptions().rawBranch) return;
  const { keys, inclusive } = sharedKeysOf(this);
  this._sharedKeys = keys;
  // a projection that asks for shared fields must also bring the link to the organization
  if (keys.length && inclusive && !hasKey(this.projection(), 'organization')) this.select('organization');
}

function setValue(doc, key, value) {
  if (doc instanceof mongoose.Document) {
    doc.set(key, value);
    doc.unmarkModified(key);
  } else {
    doc[key] = value;
  }
}

async function overlay(result) {
  const keys = this._sharedKeys;
  if (!keys?.length || !result) return;
  const docs = (Array.isArray(result) ? result : [result]).filter((d) => d && d.organization);
  if (!docs.length) return;
  const orgIdOf = (d) => String(d.organization?._id ?? d.organization);
  const orgIds = [...new Set(docs.map(orgIdOf))];
  const Organization = mongoose.model('Organization');
  const query = Organization.find({ _id: { $in: orgIds } }).select(keys.join(' ')).lean();
  const session = this.getOptions().session;
  if (session) query.session(session);
  const orgs = new Map((await query).map((o) => [String(o._id), o]));
  for (const doc of docs) {
    const org = orgs.get(orgIdOf(doc));
    if (!org) continue;
    for (const key of keys) if (org[key] !== undefined) setValue(doc, key, org[key]);
  }
}

export function companyMastersPlugin(schema) {
  for (const op of ['find', 'findOne']) {
    schema.pre(op, prepare);
    schema.post(op, overlay);
  }
}
