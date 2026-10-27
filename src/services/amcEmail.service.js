// AMC emails to the three sides of a visit — the client, the company (its owners and its own contact address) and the
// staff — in the company's name and colour, each with a button to where they act on it. Sent alongside the push and
// inbox notifications (notification.service.js); each email goes out once per event and recipient (mail.service.js).
import { env } from '../config/env.js';
import { ROLES } from '../constants/index.js';
import { Client, Company, Design, User } from '../models/index.js';
import { isEmail, isMailConfigured, sendMailOnce } from './mail.service.js';
import { effectiveFrom, rolesById } from './permission.service.js';

const HEX = /^#[0-9a-f]{6}$/i;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const link = (path) => `${env.frontendUrl}${path}`;

/** One email: the company's name in its colour, a heading, a short message, the visit's details and one button. */
export function amcEmail({ company, heading, intro, rows = [], cta, footnote }) {
  const brand = HEX.test(company.theme?.primary || '') ? company.theme.primary : '#0f766e';
  const details = rows.filter(([, v]) => v);
  const contact = [company.phone, company.email].filter(Boolean).join(' · ');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<span style="display:none;max-height:0;overflow:hidden">${esc(intro)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="background:${brand};padding:18px 28px;color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.2px">${esc(company.name)}</td></tr>
<tr><td style="padding:28px 28px 8px">
<h1 style="margin:0 0 10px;font-size:20px;line-height:1.3;color:#0f172a">${esc(heading)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#334155">${esc(intro)}</p>
</td></tr>
${details.length ? `<tr><td style="padding:18px 28px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:8px;border-left:3px solid ${brand}">
${details.map(([k, v]) => `<tr><td style="padding:9px 14px;font-size:13px;color:#64748b;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:9px 14px;font-size:14px;color:#0f172a;font-weight:600">${esc(v)}</td></tr>`).join('\n')}
</table></td></tr>` : ''}
${cta ? `<tr><td style="padding:22px 28px 6px"><a href="${esc(cta.url)}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">${esc(cta.label)}</a></td></tr>` : ''}
<tr><td style="padding:18px 28px 26px;font-size:12px;line-height:1.6;color:#64748b">${footnote ? `${esc(footnote)}<br>` : ''}${esc(company.name)}${contact ? ` · ${esc(contact)}` : ''}</td></tr>
</table>
<p style="margin:14px 0 0;font-size:11px;color:#94a3b8">You are receiving this because of an AMC (maintenance) visit with ${esc(company.name)}.</p>
</td></tr></table></body></html>`;
  const text = [heading, '', intro, '', ...details.map(([k, v]) => `${k}: ${v}`), ...(cta ? ['', `${cta.label}: ${cta.url}`] : []), '', [company.name, contact].filter(Boolean).join(' · ')].join('\n');
  return { html, text };
}

/* ───────────── who ───────────── */

const unique = (list) => [...new Map(list.filter((r) => isEmail(r.email)).map((r) => [r.email.trim().toLowerCase(), { ...r, email: r.email.trim() }])).values()];

/** The company's owners and its own contact address (e.g. info@…), which hears about every AMC event. */
async function companyPeople(company) {
  const owners = await User.find({ company: company._id, role: ROLES.COMPANY, active: true }).select('_id name email').lean();
  return unique([...owners.map((u) => ({ id: String(u._id), name: u.name, email: u.email })), { id: null, name: company.name, email: company.email }]);
}

/** The client's own email and their portal logins. */
async function clientPeople(companyId, clientId) {
  if (!clientId) return [];
  const [client, logins] = await Promise.all([
    Client.findOne({ _id: clientId, company: companyId }).select('name email').lean(),
    User.find({ company: companyId, role: ROLES.CLIENT, client: clientId, active: true }).select('_id name email').lean(),
  ]);
  return unique([...(client ? [{ id: null, name: client.name, email: client.email }] : []), ...logins.map((u) => ({ id: String(u._id), name: u.name || client?.name, email: u.email }))]);
}

async function staffById(companyId, ids) {
  const list = await User.find({ _id: { $in: ids.filter(Boolean) }, company: companyId, role: ROLES.AGENT, active: true }).select('_id name email').lean();
  return unique(list.map((u) => ({ id: String(u._id), name: u.name, email: u.email })));
}

/** Active staff holding `permission` through their roles or own grants, as they are now. */
async function staffWith(companyId, permission) {
  const [staff, roles] = await Promise.all([
    User.find({ company: companyId, role: ROLES.AGENT, active: true }).select('_id name email permissions staffRoles').lean(),
    rolesById(companyId),
  ]);
  return unique(staff.filter((u) => effectiveFrom(u, roles).includes(permission)).map((u) => ({ id: String(u._id), name: u.name, email: u.email })));
}

/** The visit's context: company, proposal (name, site) and client. */
async function context(companyId, designId, clientId) {
  const [company, design] = await Promise.all([
    Company.findById(companyId).select('name email phone theme').lean(),
    designId ? Design.findOne({ _id: designId, company: companyId }).select('name client summary.address').lean() : null,
  ]);
  if (!company) return null;
  const client = await Client.findOne({ _id: clientId || design?.client, company: companyId }).select('name phone').lean();
  return { company, site: design?.name || '', address: design?.summary?.address || '', client, clientId: clientId || design?.client };
}

/** Sends `build(person)` to each person once for this event (`key`), leaving out whoever caused it. */
async function sendEach(people, { company, key, actorId, build }) {
  for (const person of people) {
    if (actorId && person.id === String(actorId)) continue;
    const { subject, ...content } = build(person);
    const { html, text } = amcEmail({ company, ...content });
    await sendMailOnce({ key: `${key}:${person.email.toLowerCase()}`, to: person.email, subject, html, text, fromName: company.name, replyTo: company.email, companyId: company._id });
  }
}

const hello = (person, fallback = 'there') => `Hi ${person.name?.split(' ')[0] || fallback},`;

/* ───────────── events ───────────── */

/** A client booked an AMC package: confirmation to the client; the company and staff who may assign are asked to assign someone. */
export async function emailAmcRequested({ companyId, designId, clientId, packageName, requestedDate, note, eventId }) {
  if (!isMailConfigured()) return;
  const ctx = await context(companyId, designId, clientId);
  if (!ctx) return;
  const { company, site, address, client } = ctx;
  const key = `amc-requested:${eventId}`;
  const rows = [['Package', packageName], ['Preferred date', day(requestedDate)], ['Site', site], ['Address', address]];
  await sendEach(await clientPeople(companyId, ctx.clientId), {
    company, key: `${key}:client`,
    build: (p) => ({ subject: `We’ve received your AMC request — ${packageName}`, heading: 'AMC request received', intro: `${hello(p)} thank you for booking ${packageName}. We’ll assign a technician and let you know who is coming.`, rows, cta: { label: 'View in your portal', url: link('/portal/maintenance') } }),
  });
  const teamRows = [['Client', [client?.name, client?.phone].filter(Boolean).join(' · ')], ...rows, ['Client’s note', note]];
  await sendEach(await companyPeople(company), {
    company, key: `${key}:company`,
    build: () => ({ subject: `New AMC request: ${packageName} — ${client?.name || site}`, heading: 'New AMC request', intro: `${client?.name || 'A client'} has booked ${packageName}. Assign a staff member to the visit.`, rows: teamRows, cta: { label: 'Assign staff', url: link('/dashboard/amc') } }),
  });
  await sendEach(await staffWith(companyId, 'tasks:assign'), {
    company, key: `${key}:staff`,
    build: (p) => ({ subject: `New AMC request: ${packageName} — ${client?.name || site}`, heading: 'New AMC request', intro: `${hello(p)} ${client?.name || 'a client'} has booked ${packageName}. Assign a staff member to the visit.`, rows: teamRows, cta: { label: 'Open AMC visits', url: link('/agent/amc?scope=all') } }),
  });
}

/** Someone was assigned to a visit: the client learns who is coming, the staff member gets the job, the company a record. */
export async function emailAmcAssigned({ companyId, clientId, projectId, designId, packageName, requestedDate, assigneeId, assigneeName, actorId, eventId }) {
  if (!isMailConfigured()) return;
  const ctx = await context(companyId, designId, clientId);
  if (!ctx) return;
  const { company, site, address, client } = ctx;
  const key = `amc-assigned:${eventId}`;
  await sendEach(await clientPeople(companyId, ctx.clientId), {
    company, key: `${key}:client`,
    build: (p) => ({ subject: `Technician assigned for your AMC visit — ${day(requestedDate)}`, heading: 'Your technician is assigned', intro: `${hello(p)} ${assigneeName || 'a technician'} will carry out your ${packageName} visit.`, rows: [['Visit', packageName], ['Date', day(requestedDate)], ['Technician', assigneeName], ['Site', site]], cta: { label: 'View in your portal', url: link('/portal/maintenance') } }),
  });
  const jobRows = [['Visit', packageName], ['Date', day(requestedDate)], ['Client', [client?.name, client?.phone].filter(Boolean).join(' · ')], ['Site', site], ['Address', address]];
  await sendEach(await staffById(companyId, [assigneeId]), {
    company, key: `${key}:staff`, actorId,
    build: (p) => ({ subject: `AMC visit assigned to you: ${packageName} on ${day(requestedDate)}`, heading: 'AMC visit assigned to you', intro: `${hello(p)} you have been assigned the ${packageName} visit for ${client?.name || site}. Tick every checklist item when you complete it.`, rows: jobRows, cta: { label: 'Open the visit', url: link(projectId ? `/agent/projects/${projectId}` : '/agent/amc') } }),
  });
  await sendEach(await companyPeople(company), {
    company, key: `${key}:company`, actorId,
    build: () => ({ subject: `AMC visit assigned: ${packageName} → ${assigneeName || 'staff'}`, heading: 'AMC visit assigned', intro: `${assigneeName || 'A staff member'} will carry out the ${packageName} visit for ${client?.name || site}.`, rows: [['Technician', assigneeName], ...jobRows], cta: { label: 'Open the AMC tracker', url: link('/dashboard/amc') } }),
  });
}

/** A visit is due within a week: a reminder to the client, the company, and the assigned staff member (or those who assign). */
export async function emailAmcUpcoming({ companyId, clientId, projectId, designId, visitName, dueDate, assigneeId, eventId }) {
  if (!isMailConfigured()) return;
  const ctx = await context(companyId, designId, clientId);
  if (!ctx) return;
  const { company, site, address, client } = ctx;
  const key = `amc-upcoming:${eventId}`;
  await sendEach(await clientPeople(companyId, ctx.clientId), {
    company, key: `${key}:client`,
    build: (p) => ({ subject: `Your maintenance visit is coming up on ${day(dueDate)}`, heading: 'Your maintenance visit is coming up', intro: `${hello(p)} your ${visitName} visit is scheduled for ${day(dueDate)}. No booking is needed — we’ll be in touch before we come.`, rows: [['Visit', visitName], ['Date', day(dueDate)], ['Site', site]], cta: { label: 'View in your portal', url: link('/portal/maintenance') } }),
  });
  const rows = [['Visit', visitName], ['Due', day(dueDate)], ['Client', [client?.name, client?.phone].filter(Boolean).join(' · ')], ['Site', site], ['Address', address]];
  await sendEach(await companyPeople(company), {
    company, key: `${key}:company`,
    build: () => ({ subject: `Upcoming AMC visit: ${visitName} on ${day(dueDate)} — ${client?.name || site}`, heading: 'AMC visit due this week', intro: `${visitName} for ${client?.name || site} is due on ${day(dueDate)}.${assigneeId ? '' : ' No one is assigned to it yet.'}`, rows, cta: { label: 'Open the installation', url: link(`/dashboard/installations/${projectId}`) } }),
  });
  const assigned = assigneeId ? await staffById(companyId, [assigneeId]) : [];
  await sendEach(assigned.length ? assigned : await staffWith(companyId, 'tasks:assign'), {
    company, key: `${key}:staff`,
    build: (p) => (assigned.length
      ? { subject: `Reminder: ${visitName} on ${day(dueDate)} — ${client?.name || site}`, heading: 'Your AMC visit is due this week', intro: `${hello(p)} you are assigned the ${visitName} visit due on ${day(dueDate)}.`, rows, cta: { label: 'Open the visit', url: link(`/agent/projects/${projectId}`) } }
      : { subject: `Unassigned AMC visit due ${day(dueDate)} — ${client?.name || site}`, heading: 'AMC visit due — nobody assigned', intro: `${hello(p)} ${visitName} for ${client?.name || site} is due on ${day(dueDate)} and has no one assigned.`, rows, cta: { label: 'Assign staff', url: link('/agent/amc?scope=all') } }),
  });
}

/** A visit was completed: the client gets the confirmation, the company a record, and the assigned staff member if someone else closed it. */
export async function emailAmcCompleted({ companyId, clientId, projectId, designId, visitName, completedByName, completionNote, assigneeId, actorId, eventId }) {
  if (!isMailConfigured()) return;
  const ctx = await context(companyId, designId, clientId);
  if (!ctx) return;
  const { company, site, client } = ctx;
  const key = `amc-completed:${eventId}`;
  const rows = [['Visit', visitName], ['Completed on', day(new Date())], ['Completed by', completedByName], ['Site', site], ['Notes', completionNote]];
  await sendEach(await clientPeople(companyId, ctx.clientId), {
    company, key: `${key}:client`,
    build: (p) => ({ subject: `Your AMC visit is complete — ${visitName}`, heading: 'Maintenance visit completed', intro: `${hello(p)} your ${visitName} visit has been completed and every checklist item was checked. Thank you for choosing ${company.name}.`, rows, cta: { label: 'View in your portal', url: link('/portal/maintenance') } }),
  });
  await sendEach(await companyPeople(company), {
    company, key: `${key}:company`, actorId,
    build: () => ({ subject: `AMC visit completed: ${visitName} — ${client?.name || site}`, heading: 'AMC visit completed', intro: `${completedByName || 'Your team'} completed ${visitName} for ${client?.name || site}.`, rows, cta: { label: 'Open the installation', url: link(`/dashboard/installations/${projectId}`) } }),
  });
  await sendEach(await staffById(companyId, [assigneeId]), {
    company, key: `${key}:staff`, actorId,
    build: (p) => ({ subject: `AMC visit marked complete: ${visitName}`, heading: 'Your AMC visit was marked complete', intro: `${hello(p)} ${completedByName || 'the company'} marked the ${visitName} visit for ${client?.name || site} as completed.`, rows, cta: { label: 'Open the visit', url: link(`/agent/projects/${projectId}`) } }),
  });
}
