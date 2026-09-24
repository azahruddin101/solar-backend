// One complete demo company (Surya Shakti Energy Solutions): profile, team, clients, a multi-product catalog,
// packages, designs, installations at different stages, support tickets and notifications.
//   npm run seed:showcase            add it (does nothing if it already exists)
//   npm run seed:showcase -- --replace   delete it and create it again
import mongoose from 'mongoose';
import { DEFAULT_INSTALLATION_STEPS, ROLES } from '../constants/index.js';
import { Category, Client, Company, Design, Notification, Package, Plan, Product, Project, Ticket, User } from '../models/index.js';
import { applyPlanLimitsToCompany } from '../services/plan.service.js';
import { deleteCompany } from '../services/company.service.js';
import { putFile } from '../services/storage.service.js';
import { hashPassword } from '../utils/password.js';
import { cleanRichText } from '../utils/richText.js';
import { DEMO_PASSWORD } from './data/companies.js';
import { SHOWCASE_AGENTS, SHOWCASE_CATEGORIES, SHOWCASE_CLIENTS, SHOWCASE_COMPANY, SHOWCASE_DESIGNS, SHOWCASE_INSTALLATIONS, SHOWCASE_LOGIN, SHOWCASE_PACKAGES, SHOWCASE_TICKETS } from './data/showcase.js';
import { writeBrandImages } from './demo.seeder.js';
import { ensureDefaultPlans } from './plans.seeder.js';

const daysAgo = (n, hours = 0) => new Date(Date.now() - n * 86400000 + hours * 3600000);

/** A minimal but valid one-page PDF, so demo documents open. */
function tinyPdf(lines) {
  const clean = (s) => s.replace(/[()\\]/g, '');
  const stream = lines.map((l, i) => `BT /F1 12 Tf 50 ${770 - i * 20} Td (${clean(l)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function makeDocument(company, name, lines) {
  const buffer = tinyPdf(lines);
  const fileName = `${company.id}-doc-seed-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
  await putFile(fileName, buffer, 'application/pdf');
  return { name, url: `/uploads/${fileName}`, size: buffer.length, mimetype: 'application/pdf', uploadedAt: daysAgo(20) };
}

export async function seedShowcase({ replace = false } = {}) {
  await ensureDefaultPlans();
  const existing = await User.findOne({ email: SHOWCASE_LOGIN.email });
  if (existing) {
    if (!replace) {
      console.log(`  = ${SHOWCASE_COMPANY.name} already exists (use --replace to recreate it)`);
      return null;
    }
    await deleteCompany(existing.company);
    console.log('  - existing showcase company removed');
  }

  /* company + owner */
  const company = await Company.create({ ...SHOWCASE_COMPANY, pdfTerms: cleanRichText(SHOWCASE_COMPANY.pdfTerms), installationSteps: DEFAULT_INSTALLATION_STEPS, plan: 'growth', createdAt: daysAgo(75) });
  const plan = await Plan.findOne({ code: 'pro' });
  if (plan) {
    company.planRef = plan._id;
    applyPlanLimitsToCompany(company, plan);
    company.subscription = { periodStart: daysAgo(12), periodEnd: daysAgo(-18) };
  }
  await company.save();
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const owner = await User.create({ email: SHOWCASE_LOGIN.email, name: SHOWCASE_LOGIN.name, phone: SHOWCASE_COMPANY.phone, passwordHash, role: ROLES.COMPANY, company: company._id, lastLoginAt: daysAgo(0, -2) });
  await writeBrandImages(company);

  /* team */
  const agents = new Map();
  for (const a of SHOWCASE_AGENTS) {
    const agent = await User.create({ ...a, passwordHash, role: ROLES.AGENT, company: company._id, active: true, lastLoginAt: daysAgo(1) });
    agents.set(a.email.split('@')[0], agent);
  }

  /* catalog */
  const bySku = new Map();
  for (const [position, c] of SHOWCASE_CATEGORIES.entries()) {
    const { products, ...fields } = c;
    const category = await Category.create({ ...fields, type: fields.type || 'general', company: company._id, position: position + 1 });
    for (const p of products) {
      const product = await Product.create({ ...p, company: company._id, category: category._id, type: category.type });
      if (p.sku) bySku.set(p.sku, product);
    }
  }
  for (const pkg of SHOWCASE_PACKAGES) {
    const { lines, ...fields } = pkg;
    const items = lines.map(([sku, qty]) => {
      const product = bySku.get(sku);
      if (!product) throw new Error(`Package "${pkg.name}" uses an unknown product ${sku}`);
      return { productId: product._id, qty, unit: product.unit };
    });
    await Package.create({ ...fields, items, company: company._id });
  }

  /* clients + documents */
  const clients = new Map();
  for (const [i, { key, ...c }] of SHOWCASE_CLIENTS.entries()) {
    const created = daysAgo(60 - i * 6);
    const documents = [];
    if (key === 'joshi') documents.push(await makeDocument(company, 'MSEDCL Electricity Bill', ['MSEDCL - Electricity Bill', 'Consumer No: 170012345678', 'Consumer: Amit Joshi', 'Billing month: last month', 'Units consumed: 612', 'Amount payable: Rs 6,842']));
    if (key === 'school') documents.push(await makeDocument(company, 'Sanction Letter 25 kW', ['MSEDCL - Sanction Letter', 'Consumer No: 170098471203', 'Green Valley English Medium School', 'Sanctioned load: 25 kW rooftop solar (net metering)']));
    clients.set(key, await Client.create({ ...c, documents, company: company._id, createdAt: created, updatedAt: created }));
  }

  /* designs */
  const designs = new Map();
  for (const [i, d] of SHOWCASE_DESIGNS.entries()) {
    const client = clients.get(d.client);
    const updated = daysAgo(2 + i * 3);
    designs.set(d.name, await Design.create({
      company: company._id, client: client._id, name: d.name, status: d.status, data: d.data || null,
      summary: { ...(d.summary || {}), address: d.data?.place.address || '' },
      logs: [{ action: 'design_created', by: owner._id, byName: owner.name, byRole: ROLES.COMPANY, message: d.name, at: daysAgo(6 + i * 3) }],
      createdAt: daysAgo(6 + i * 3), updatedAt: updated,
    }));
  }

  /* installations */
  for (const inst of SHOWCASE_INSTALLATIONS) {
    const design = designs.get(inst.design);
    const origin = design.data?.origin || { lat: 18.52, lng: 73.85 };
    const logs = [{ action: 'started', by: owner._id, byName: owner.name, byRole: ROLES.COMPANY, at: daysAgo(inst.startedDaysAgo) }];
    const steps = DEFAULT_INSTALLATION_STEPS.map((tpl, i) => {
      const [status, who, when, note] = inst.steps[i];
      const agent = agents.get(who);
      const started = when == null ? null : daysAgo(when + (status === 'done' ? 1 : 0));
      const done = status === 'done' ? daysAgo(when) : null;
      return { _id: new mongoose.Types.ObjectId(), name: tpl.name, description: tpl.description, role: tpl.role, assignee: agent._id, status, startedAt: started, completedAt: done, _agent: agent, _note: note, _when: when };
    });
    for (const s of steps) {
      const base = { step: s._id, stepName: s.name };
      logs.push({ ...base, action: 'step_assigned', by: owner._id, byName: owner.name, byRole: ROLES.COMPANY, message: `${s._agent.name} · auto-assigned`, at: daysAgo(inst.startedDaysAgo) });
      if (s.status !== 'pending') logs.push({ ...base, action: 'step_started', by: s._agent._id, byName: s._agent.name, byRole: ROLES.AGENT, message: '', at: s.startedAt });
      if (s.status === 'done') {
        const jitter = () => (Math.random() - 0.5) * 0.0004;
        logs.push({ ...base, action: 'step_completed', by: s._agent._id, byName: s._agent.name, byRole: ROLES.AGENT, message: s._note, lat: +(origin.lat + jitter()).toFixed(6), lng: +(origin.lng + jitter()).toFixed(6), at: s.completedAt });
      } else if (s.status === 'in_progress' && s._note) {
        logs.push({ ...base, action: 'note', by: s._agent._id, byName: s._agent.name, byRole: ROLES.AGENT, message: s._note, at: daysAgo(s._when) });
      }
    }
    const complete = steps.every((s) => s.status === 'done');
    if (complete) logs.push({ action: 'completed', by: owner._id, byName: owner.name, byRole: ROLES.COMPANY, at: steps.at(-1).completedAt });
    logs.sort((a, b) => a.at - b.at);
    await Project.create({
      company: company._id, design: design._id, client: design.client,
      status: complete ? 'completed' : 'active',
      steps: steps.map(({ _agent, _note, _when, ...s }) => s),
      logs, createdAt: daysAgo(inst.startedDaysAgo), updatedAt: logs.at(-1).at,
    });
    design.logs.push({ action: 'installation_started', by: owner._id, byName: owner.name, byRole: ROLES.COMPANY, message: `${steps.length} steps from company template`, at: daysAgo(inst.startedDaysAgo) });
    if (complete) design.logs.push({ action: 'installation_completed', by: owner._id, byName: owner.name, byRole: ROLES.COMPANY, message: 'All installation steps finished', at: steps.at(-1).completedAt });
    await design.save();
  }

  /* support tickets (need a super admin to answer) */
  const admin = await User.findOne({ role: ROLES.SUPERADMIN });
  if (admin) {
    for (const t of SHOWCASE_TICKETS) {
      const messages = t.messages.map(([from, body, ago]) => {
        const user = from === 'admin' ? admin : owner;
        return { author: user._id, authorName: user.name || user.email, authorRole: user.role, body, createdAt: daysAgo(ago) };
      });
      const logs = [
        { action: 'created', by: owner._id, byName: owner.name, byRole: ROLES.COMPANY, message: t.subject, at: messages[0].createdAt },
        ...messages.slice(1).map((m) => ({ action: 'message', by: m.author, byName: m.authorName, byRole: m.authorRole, message: 'Sent a message', at: m.createdAt })),
        ...(t.status !== 'open' ? [{ action: 'status_changed', by: admin._id, byName: admin.name || admin.email, byRole: ROLES.SUPERADMIN, message: `Open → ${t.status === 'resolved' ? 'Resolved' : t.status}`, at: messages.at(-1).createdAt }] : []),
      ];
      await Ticket.create({
        company: company._id, createdBy: owner._id, subject: t.subject, category: t.category, priority: t.priority, status: t.status,
        messages, logs, adminUnread: t.status === 'open' ? 1 : 0, companyUnread: 0, lastMessageAt: messages.at(-1).createdAt,
      });
    }
  } else console.log('  ! no super admin yet: support tickets skipped (run npm run seed first)');

  /* notifications, so the inbox isn't empty */
  const school = await Project.findOne({ company: company._id, design: designs.get('Green Valley School – main block')._id });
  const hospital = await Project.findOne({ company: company._id, design: designs.get('Aarogya Hospital – terrace plant')._id });
  const note = (user, title, body, path, ago, read, key) => Notification.create({ user: user._id, company: company._id, type: 'demo', title, body, path, eventKey: `showcase:${key}`, readAt: read ? daysAgo(ago) : null, createdAt: daysAgo(ago) });
  await note(owner, 'Installation Step Updated', 'Site inspection has been marked as Done (Green Valley School – main block).', `/dashboard/installations/${school.id}`, 9, true, 'o1');
  await note(owner, 'Installation Step Updated', 'Material procurement has been marked as Done (Green Valley School – main block).', `/dashboard/installations/${school.id}`, 4, true, 'o2');
  await note(owner, 'Installation Step Updated', 'Structure installation has been marked as In progress (Green Valley School – main block).', `/dashboard/installations/${school.id}`, 1, false, 'o3');
  await note(owner, 'Installation Step Updated', 'Site inspection has been marked as In progress (Aarogya Hospital – terrace plant).', `/dashboard/installations/${hospital.id}`, 1, false, 'o4');
  await note(agents.get('ganesh.jadhav'), 'New Installation Step Assigned', 'You have been assigned “Structure installation” (Green Valley School – main block).', `/agent/projects/${school.id}`, 4, false, 'a1');
  await note(agents.get('farah.sayyed'), 'New Installation Step Assigned', 'You have been assigned “Site inspection” (Aarogya Hospital – terrace plant).', `/agent/projects/${hospital.id}`, 3, false, 'a2');

  console.log(`  + ${company.name}: ${SHOWCASE_AGENTS.length} agents, ${SHOWCASE_CLIENTS.length} clients, ${SHOWCASE_CATEGORIES.length} categories, ${bySku.size} products, ${SHOWCASE_PACKAGES.length} packages, ${SHOWCASE_DESIGNS.length} designs, ${SHOWCASE_INSTALLATIONS.length} installations`);
  return company;
}
