// Full branch demo data (showcase clients, designs, billing, leads, loans, …). Used by showcase and testing-company seeders.
import mongoose from 'mongoose';
import {
  DEFAULT_EXPENSE_REASONS,
  DEFAULT_INSTALLATION_STEPS,
  DEFAULT_LOAN_STEPS,
  DEFAULT_SUBSIDY_STEPS,
  ROLES,
} from '../constants/index.js';
import {
  Client,
  ClientTicket,
  Design,
  Expense,
  Loan,
  Notification,
  Organization,
  Package,
  Project,
  SerialUnit,
  Subsidy,
  Ticket,
  User,
} from '../models/index.js';
import { spawnAmcVisitsForProject } from '../services/amc.service.js';
import { billService } from '../services/bill.service.js';
import { billingService } from '../services/billing.service.js';
import { ewayBillService } from '../services/ewayBill.service.js';
import { leadModels } from '../integrations/leads.js';
import { putFile } from '../services/storage.service.js';
import { hashPassword } from '../utils/password.js';
import {
  SHOWCASE_AGENTS,
  SHOWCASE_CLIENTS,
  SHOWCASE_DESIGNS,
  SHOWCASE_INSTALLATIONS,
  SHOWCASE_PACKAGES,
  SHOWCASE_TICKETS,
} from './data/showcase.js';
import { seedBranchStockForOrgCatalog, seedShowcaseCatalog } from './showcaseCatalog.js';

const daysAgo = (n, hours = 0) => new Date(Date.now() - n * 86400000 + hours * 3600000);

const LEAD_DEFAULT_STATUSES = [
  { name: 'New', color: 'slate' },
  { name: 'Interested', color: 'amber' },
  { name: 'Callback', color: 'blue' },
  { name: 'Site visit', color: 'purple' },
  { name: 'Converted', color: 'emerald', outcome: 'converted', isConversion: true },
  { name: 'Lost', color: 'rose', outcome: 'lost' },
];

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

const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

function offsetPhone(phone, branchIndex) {
  const digits = String(phone || '').replace(/\D/g, '');
  const base = digits.slice(-10);
  const n = (Number(base) + branchIndex * 137) % 9000000000 + 1000000000;
  return String(n);
}

function agentEmail(localPart, domain) {
  return `${localPart}@${domain}`;
}

async function ensureLeadStatuses(companyId) {
  const base = { company: companyId, isDeleted: false };
  if (await leadModels.status.countDocuments(base)) return leadModels.status.find(base).sort({ order: 1 });
  await leadModels.status.insertMany(
    LEAD_DEFAULT_STATUSES.map((status, index) => ({
      ...status,
      company: companyId,
      nameKey: status.name.toLowerCase(),
      order: index,
      isActive: true,
    })),
    { ordered: true },
  );
  return leadModels.status.find(base).sort({ order: 1 });
}

async function seedLeads(company, owner, agents, branchIndex) {
  const statuses = await ensureLeadStatuses(company._id);
  const fresh = statuses.find((s) => s.name === 'New');
  const callback = statuses.find((s) => s.name === 'Callback');
  const agent = [...agents.values()][0];
  const tag = branchIndex + 1;

  await leadModels.manual.create({
    company: company._id,
    fullName: `Manual lead (${company.name})`,
    phone: offsetPhone('9822011223', branchIndex),
    phoneKey: phoneKey(offsetPhone('9822011223', branchIndex)),
    address: 'Near demo colony, Pune',
    assignedTo: agent?._id,
    assignedAt: daysAgo(2),
    status: callback?._id ?? fresh?._id,
    statusName: callback?.name ?? fresh?.name ?? 'New',
    statusColor: callback?.color ?? fresh?.color ?? 'slate',
    statusUpdatedAt: daysAgo(2),
    createdBy: owner._id,
    createdByName: owner.name,
    createdAt: daysAgo(5),
  });

  await leadModels.manual.create({
    company: company._id,
    fullName: 'Unassigned web enquiry',
    phone: offsetPhone('9011023456', branchIndex),
    phoneKey: phoneKey(offsetPhone('9011023456', branchIndex)),
    address: 'Lead pool — assign to telecaller',
    status: fresh?._id,
    statusName: fresh?.name ?? 'New',
    statusColor: fresh?.color ?? 'slate',
    createdAt: daysAgo(1),
  });

  await leadModels.meta.create({
    company: company._id,
    source: 'META',
    externalLeadId: `testing-meta-${tag}-${company.id}`,
    pageId: '123456789',
    pageName: 'Testing Solar Page',
    formId: 'form-demo',
    formName: '5 kW enquiry',
    fullName: 'Meta lead prospect',
    phone: offsetPhone('9765012345', branchIndex),
    searchText: 'meta lead prospect',
    assignedTo: agent?._id,
    assignedAt: daysAgo(3),
    status: fresh?._id,
    statusName: fresh?.name ?? 'New',
    statusColor: fresh?.color ?? 'slate',
    createdAt: daysAgo(4),
  });

  await leadModels.google.create({
    company: company._id,
    externalLeadId: `testing-google-${tag}-${company.id}`,
    formId: 'google-form-1',
    campaignId: 'camp-demo',
    fullName: 'Google Ads lead',
    phone: offsetPhone('9309876543', branchIndex),
    searchText: 'google ads lead',
    status: fresh?._id,
    statusName: fresh?.name ?? 'New',
    statusColor: fresh?.color ?? 'slate',
    createdAt: daysAgo(2),
  });
}

async function seedLoansSubsidiesExpenses(company, owner, designs, clients) {
  const wonLoan = designs.get('Joshi residence – 5 kW rooftop');
  if (wonLoan) {
    wonLoan.loanRequired = true;
    await wonLoan.save();
    await Loan.create({
      company: company._id,
      design: wonLoan._id,
      client: wonLoan.client,
      lender: 'State Bank of India',
      branch: 'Kothrud',
      amount: 180000,
      interestRate: 9.5,
      tenureMonths: 60,
      status: 'in_progress',
      steps: DEFAULT_LOAN_STEPS.map((s, i) => ({
        ...s,
        status: i < 2 ? 'done' : i === 2 ? 'in_progress' : 'pending',
        completedAt: i < 2 ? daysAgo(20 - i * 3) : null,
      })),
      logs: [{ action: 'created', byName: owner.name, message: 'Loan file opened', at: daysAgo(25) }],
    });
  }

  const subsidyDesign = designs.get('Deshmukh terrace – 3 kW');
  if (subsidyDesign) {
    subsidyDesign.subsidy = { enabled: true, central: 78000, state: 10000 };
    await subsidyDesign.save();
    await Subsidy.create({
      company: company._id,
      design: subsidyDesign._id,
      client: subsidyDesign.client,
      scheme: 'PM Surya Ghar',
      applicationNo: `PMSG-${company.id.slice(-6)}`,
      status: 'in_progress',
      steps: DEFAULT_SUBSIDY_STEPS.map((s, i) => ({
        ...s,
        status: i < 3 ? 'done' : 'pending',
        completedAt: i < 3 ? daysAgo(15 - i * 2) : null,
      })),
    });
  }

  if (wonLoan) {
    await Expense.create({
      company: company._id,
      design: wonLoan._id,
      amount: 4200,
      reason: DEFAULT_EXPENSE_REASONS[0],
      spentOn: daysAgo(8),
      createdBy: owner._id,
      note: 'Material transport to site',
    });
  }

  const joshi = clients.get('joshi');
  if (joshi) {
    await ClientTicket.create({
      company: company._id,
      client: joshi._id,
      createdBy: owner._id,
      subject: 'Inverter display question',
      category: 'service',
      status: 'open',
      messages: [{ author: owner._id, body: 'Client asked about daily generation on the app.', createdAt: daysAgo(2) }],
    });
  }
}

/**
 * @param {object} opts
 * @param {import('../models/company.model.js').Company} opts.company
 * @param {import('../models/user.model.js').User} opts.owner branch owner (or sole owner)
 * @param {string} opts.password agent password
 * @param {Map} [opts.bySku] existing org catalog products
 * @param {boolean} [opts.seedCatalog] create org catalog + stock on this branch
 * @param {string} [opts.branchTag] short id for serial numbers / stock batches
 * @param {number} [opts.branchIndex] 0-based — offsets phones
 * @param {string} [opts.agentDomain] email domain for staff
 * @param {boolean} [opts.platformTickets] seed tickets to super admin
 */
export async function seedBranchShowcaseData({
  company,
  owner,
  password,
  bySku: existingSku,
  seedCatalog = false,
  branchTag = 'main',
  branchIndex = 0,
  agentDomain = 'testingcompany.test',
  platformTickets = true,
}) {
  let bySku = existingSku;
  if (seedCatalog) bySku = await seedShowcaseCatalog(company._id);
  else if (bySku?.size) await seedBranchStockForOrgCatalog(company._id, bySku, branchTag);

  const ownerRole = owner.role === ROLES.COMPANY ? ROLES.BRANCH : owner.role;

  const agents = new Map();
  for (const a of SHOWCASE_AGENTS) {
    const local = a.email.split('@')[0];
    const email = agentEmail(local, agentDomain);
    if (await User.exists({ email })) continue;
    const agent = await User.create({
      ...a,
      email,
      passwordHash: await hashPassword(password),
      role: ROLES.AGENT,
      company: company._id,
      organization: company.organization,
      active: true,
      lastLoginAt: daysAgo(1),
    });
    agents.set(local, agent);
  }

  for (const pkg of SHOWCASE_PACKAGES) {
    const exists = await Package.findOne({ company: company._id, name: pkg.name });
    if (exists) continue;
    const { lines, ...fields } = pkg;
    const items = lines.map(([sku, qty]) => {
      const product = bySku.get(sku);
      if (!product) throw new Error(`Package "${pkg.name}" uses unknown SKU ${sku}`);
      return { productId: product._id, qty, unit: product.unit };
    });
    await Package.create({ ...fields, items, company: company._id });
  }

  const clients = new Map();
  for (const [i, { key, ...c }] of SHOWCASE_CLIENTS.entries()) {
    const created = daysAgo(60 - i * 6);
    const documents = [];
    if (key === 'joshi') documents.push(await makeDocument(company, `Bill-${branchTag}`, ['MSEDCL - Electricity Bill', 'Consumer: Amit Joshi', 'Amount payable: Rs 6,842']));
    if (key === 'school') documents.push(await makeDocument(company, `Sanction-${branchTag}`, ['MSEDCL - Sanction Letter', 'Sanctioned load: 25 kW']));
    const phone = c.phone ? offsetPhone(c.phone, branchIndex) : undefined;
    clients.set(key, await Client.create({
      ...c,
      phone,
      documents,
      company: company._id,
      createdAt: created,
      updatedAt: created,
    }));
  }

  const designs = new Map();
  for (const [i, d] of SHOWCASE_DESIGNS.entries()) {
    const client = clients.get(d.client);
    const updated = daysAgo(2 + i * 3);
    designs.set(d.name, await Design.create({
      company: company._id,
      client: client._id,
      name: d.name,
      status: d.status,
      data: d.data || null,
      summary: { ...(d.summary || {}), address: d.data?.place?.address || '' },
      logs: [{ action: 'design_created', by: owner._id, byName: owner.name, byRole: ownerRole, message: d.name, at: daysAgo(6 + i * 3) }],
      createdAt: daysAgo(6 + i * 3),
      updatedAt: updated,
    }));
  }

  for (const inst of SHOWCASE_INSTALLATIONS) {
    const design = designs.get(inst.design);
    if (!design) continue;
    const origin = design.data?.origin || { lat: 18.52, lng: 73.85 };
    const logs = [{ action: 'started', by: owner._id, byName: owner.name, byRole: ownerRole, at: daysAgo(inst.startedDaysAgo) }];
    const steps = DEFAULT_INSTALLATION_STEPS.map((tpl, i) => {
      const [status, who, when, note] = inst.steps[i];
      const agent = agents.get(who);
      const started = when == null ? null : daysAgo(when + (status === 'done' ? 1 : 0));
      const done = status === 'done' ? daysAgo(when) : null;
      return {
        _id: new mongoose.Types.ObjectId(),
        name: tpl.name,
        description: tpl.description,
        role: tpl.role,
        assignee: agent?._id,
        status,
        startedAt: started,
        completedAt: done,
        _agent: agent,
        _note: note,
        _when: when,
      };
    });
    for (const s of steps) {
      if (!s._agent) continue;
      const base = { step: s._id, stepName: s.name };
      logs.push({ ...base, action: 'step_assigned', by: owner._id, byName: owner.name, byRole: ownerRole, message: `${s._agent.name} · auto-assigned`, at: daysAgo(inst.startedDaysAgo) });
      if (s.status !== 'pending') logs.push({ ...base, action: 'step_started', by: s._agent._id, byName: s._agent.name, byRole: ROLES.AGENT, message: '', at: s.startedAt });
      if (s.status === 'done') {
        const jitter = () => (Math.random() - 0.5) * 0.0004;
        logs.push({ ...base, action: 'step_completed', by: s._agent._id, byName: s._agent.name, byRole: ROLES.AGENT, message: s._note, lat: +(origin.lat + jitter()).toFixed(6), lng: +(origin.lng + jitter()).toFixed(6), at: s.completedAt });
      } else if (s.status === 'in_progress' && s._note) {
        logs.push({ ...base, action: 'note', by: s._agent._id, byName: s._agent.name, byRole: ROLES.AGENT, message: s._note, at: daysAgo(s._when) });
      }
    }
    const complete = steps.every((s) => s.status === 'done');
    if (complete) logs.push({ action: 'completed', by: owner._id, byName: owner.name, byRole: ownerRole, at: steps.at(-1).completedAt });
    logs.sort((a, b) => a.at - b.at);
    const project = await Project.create({
      company: company._id,
      design: design._id,
      client: design.client,
      status: complete ? 'completed' : 'active',
      steps: steps.map(({ _agent, _note, _when, ...s }) => s),
      logs,
      createdAt: daysAgo(inst.startedDaysAgo),
      updatedAt: logs.at(-1).at,
    });
    if (complete) {
      const orgDoc = company.organization ? await Organization.findById(company.organization).select('amcTemplates') : company;
      await spawnAmcVisitsForProject(project, orgDoc || company, { design });
      await project.save();
    }
    design.logs.push({ action: 'installation_started', by: owner._id, byName: owner.name, byRole: ownerRole, message: `${steps.length} steps from company template`, at: daysAgo(inst.startedDaysAgo) });
    if (complete) design.logs.push({ action: 'installation_completed', by: owner._id, byName: owner.name, byRole: ownerRole, message: 'All installation steps finished', at: steps.at(-1).completedAt });
    await design.save();
  }

  const stockLine = async (sku, qty) => {
    const product = bySku.get(sku);
    if (!product.isSerialized) return { productId: product.id, qty };
    const units = await SerialUnit.find({ product: product._id, company: company._id, status: 'inStock' }).sort({ serialNo: 1 }).limit(qty).lean();
    return { productId: product.id, serials: units.map((u) => u.serialNo) };
  };
  if (bySku.has('BAT-EX-150')) {
    const battery = await stockLine('BAT-EX-150', 2);
    const kale = await Client.create({
      company: company._id,
      name: `Counter sale client (${branchTag})`,
      phone: offsetPhone('9822045566', branchIndex),
      address: 'Hadapsar, Pune 411028',
    });
    const sold = await ewayBillService.create(company, owner, { client: kale.id, lines: [{ ...battery, priceType: 'retail' }], withGst: true });
    await billService.create(company, owner, {
      client: kale.id,
      ewayBills: [sold.id],
      services: [{ name: 'Battery installation & wiring', qty: 1, unit: 'Nos', rate: 1500, gstPercent: 18 }],
      withGst: true,
      payment: { mode: 'upi', reference: `UPI-${branchTag}` },
    });
    await billingService.createInvoiceFromBills(company, owner, { client: kale.id });
  }

  if (platformTickets) {
    const admin = await User.findOne({ role: ROLES.SUPERADMIN });
    if (admin) {
      for (const t of SHOWCASE_TICKETS) {
        const exists = await Ticket.findOne({ company: company._id, subject: t.subject });
        if (exists) continue;
        const messages = t.messages.map(([from, body, ago]) => {
          const user = from === 'admin' ? admin : owner;
          return { author: user._id, authorName: user.name || user.email, authorRole: user.role, body, createdAt: daysAgo(ago) };
        });
        const logs = [
          { action: 'created', by: owner._id, byName: owner.name, byRole: ownerRole, message: t.subject, at: messages[0].createdAt },
          ...messages.slice(1).map((m) => ({ action: 'message', by: m.author, byName: m.authorName, byRole: m.authorRole, message: 'Sent a message', at: m.createdAt })),
        ];
        await Ticket.create({
          company: company._id,
          createdBy: owner._id,
          subject: t.subject,
          category: t.category,
          priority: t.priority,
          status: t.status,
          messages,
          logs,
          adminUnread: t.status === 'open' ? 1 : 0,
          companyUnread: 0,
          lastMessageAt: messages.at(-1).createdAt,
        });
      }
    }
  }

  await seedLeads(company, owner, agents, branchIndex);
  await seedLoansSubsidiesExpenses(company, owner, designs, clients);

  const school = await Project.findOne({ company: company._id, design: designs.get('Green Valley School – main block')?._id });
  const hospital = await Project.findOne({ company: company._id, design: designs.get('Aarogya Hospital – terrace plant')?._id });
  const note = (user, title, body, path, ago, read, key) => Notification.create({
    user: user._id,
    company: company._id,
    type: 'demo',
    title,
    body,
    path,
    eventKey: `testing:${branchTag}:${key}`,
    readAt: read ? daysAgo(ago) : null,
    createdAt: daysAgo(ago),
  });
  if (school) {
    await note(owner, 'Installation updated', 'Structure work in progress (school).', `/dashboard/installations/${school.id}`, 1, false, 'school');
  }
  if (hospital) {
    await note(owner, 'Installation updated', 'Site inspection started (hospital).', `/dashboard/installations/${hospital.id}`, 1, false, 'hosp');
  }

  return { bySku, agents, designs, clients };
}

export { tinyPdf, makeDocument, daysAgo };
