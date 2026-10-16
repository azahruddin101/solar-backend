// The search box on the lead tables (Meta, Google Ads, manual). One box matches any of:
//  - the lead's own answers (name, phone, email, address…: the stored searchText)
//  - Meta: the lead form's name and the Facebook Page's name
//  - the name of the staff member it is assigned to
//  - the status name (for a Meta lead: its owner's status, or the one set on the lead before anyone owns it)
//  - a date: 16/10/2026, 16-10-2026, 2026-10-16, 16 Oct, 16 Oct 2026, Oct 2026, October, today, yesterday
//    (India time; day/month order, as written in India)
const mongoose = require('mongoose');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const MetaLeadStatus = require('../models/MetaLeadStatus');
const { leadCompanyFilter } = require('./tenant');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 0–11 for a month name or its start (oct, sept, october); -1 otherwise. */
const monthOf = (word) => {
  const w = String(word || '').toLowerCase().replace(/\.$/, '');
  return w.length < 3 ? -1 : MONTHS.findIndex((name) => name.startsWith(w));
};
const fullYear = (y) => (y < 100 ? 2000 + y : y);
/** Midnight India time of a calendar day, as a UTC Date. */
const istDay = (y, m, d) => new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
const validDay = (y, m, d) => m >= 0 && m < 12 && d >= 1 && d <= new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** A day or month the search names, as { from, to } (to exclusive), or null. */
function parseDateSearch(term, now = new Date()) {
  const t = String(term || '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const today = new Date(now.getTime() + IST_OFFSET_MS); // India-time calendar fields via getUTC*
  const thisYear = today.getUTCFullYear();
  const day = (y, m, d) => (validDay(y, m, d) ? { from: istDay(y, m, d), to: istDay(y, m, d + 1) } : null);
  if (t === 'today') return day(thisYear, today.getUTCMonth(), today.getUTCDate());
  if (t === 'yesterday') {
    const y = new Date(today.getTime() - 86400000);
    return day(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate());
  }
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/); // 16/10/2026 (day first)
  if (m) return day(fullYear(+m[3]), +m[2] - 1, +m[1]);
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // 2026-10-16
  if (m) return day(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+\.?)(?: (\d{4}))?$/); // 16 oct [2026]
  if (m && monthOf(m[2]) >= 0) return day(m[3] ? +m[3] : thisYear, monthOf(m[2]), +m[1]);
  m = t.match(/^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/); // oct 16 [2026]
  if (m && monthOf(m[1]) >= 0) return day(m[3] ? +m[3] : thisYear, monthOf(m[1]), +m[2]);
  m = t.match(/^([a-z]+\.?)(?: (\d{4}))?$/); // oct [2026], october
  if (m && monthOf(m[1]) >= 0) {
    const y = m[2] ? +m[2] : thisYear;
    const mo = monthOf(m[1]);
    return { from: istDay(y, mo, 1), to: istDay(y, mo + 1, 1) };
  }
  return null;
}

/**
 * The condition for one search term on a lead table. `kind`: 'meta' | 'google' | 'manual'.
 * Returns a Mongo filter to combine with the table's other filters (`$and`).
 */
async function leadSearchCondition({ companyId, search, kind }) {
  const term = String(search || '').trim().slice(0, 100);
  if (!term) return null;
  const tenant = leadCompanyFilter(companyId);
  const rx = { $regex: escapeRegex(term), $options: 'i' };
  const or = [{ searchText: { $regex: escapeRegex(term.toLowerCase()) } }];
  if (kind === 'meta') or.push({ formName: rx }, { pageName: rx });

  const [users, statuses] = await Promise.all([
    mongoose.model('User').find({ ...tenant, role: { $in: ['company', 'agent'] }, name: rx }).select('_id').limit(100).lean(),
    MetaLeadStatus.find({ ...tenant, isDeleted: { $ne: true }, name: rx }).select('_id').lean(),
  ]);
  if (users.length) or.push({ assignedTo: { $in: users.map((u) => u._id) } });
  if (statuses.length) {
    const ids = statuses.map((s) => s._id);
    if (kind === 'meta') {
      // a Meta lead's status is its owner's status; before anyone set one, the status set on the lead
      const [byOwner, ownerHasStatus] = await Promise.all([
        MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: { $in: ids } }),
        MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: { $ne: null } }),
      ]);
      or.push({ _id: { $in: byOwner } }, { adminStatus: { $in: ids }, _id: { $nin: ownerHasStatus } });
    } else {
      or.push({ status: { $in: ids } });
    }
  }
  const range = parseDateSearch(term);
  if (range) or.push({ [kind === 'meta' ? 'leadCreatedAt' : 'createdAt']: { $gte: range.from, $lt: range.to } });
  return { $or: or };
}

/** Adds the search to a table's filter (keeps whatever else the filter already says). */
async function applyLeadSearch(filter, args) {
  const condition = await leadSearchCondition(args);
  if (condition) filter.$and = [...(filter.$and || []), condition];
  return filter;
}

module.exports = { leadSearchCondition, applyLeadSearch, parseDateSearch };
