// Demo tenants: organizations with branches, branding, catalog, clients and designs.
// Idempotent — skipped when the branch owner sign-in email already exists.
import { ROLES } from '../constants/index.js';
import { Client, Company, Design, Organization, User } from '../models/index.js';
import { publicPath } from '../services/asset.service.js';
import { createStarterCatalog } from '../services/catalog.service.js';
import { putFile } from '../services/storage.service.js';
import { hashPassword } from '../utils/password.js';
import { drawLogo, drawQr, drawSignature } from './brandImages.js';
import { COMPANIES, DEMO_PASSWORD } from './data/companies.js';
import { seedOrgTenant } from './orgTenant.seeder.js';

export async function writeBrandImages(company) {
  const website = company.website ? `https://${company.website.replace(/^https?:\/\//, '')}` : `mailto:${company.email}`;
  const images = { logo: drawLogo(company.theme), signature: drawSignature(company.signatoryName || company.name), qr: await drawQr(website) };
  for (const [kind, buffer] of Object.entries(images)) {
    const fileName = `${company.id}-${kind}-seed.png`;
    await putFile(fileName, buffer, 'image/png');
    company[kind] = publicPath(fileName);
  }
  await company.save();
  if (company.organization) {
    const org = await Organization.findById(company.organization);
    if (org) {
      org.logo = company.logo;
      org.signature = company.signature;
      org.qr = company.qr;
      await org.save();
    }
  }
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

async function seedCompany(seed, index) {
  const tenant = await seedOrgTenant({
    login: seed.login,
    company: seed.company,
    password: DEMO_PASSWORD,
    branchName: seed.branchName,
    hasBranches: Boolean(seed.hasBranches),
    branchOwner: seed.branchOwner || null,
    maxBranches: seed.maxBranches ?? 3,
    extraBranches: seed.extraBranches || [],
  });
  if (!tenant) return console.log(`  = ${seed.company.name} (already exists, skipped)`);

  const { branch } = tenant;
  await writeBrandImages(branch);
  await createStarterCatalog(branch._id, { panels: seed.panels, pillars: seed.pillars });

  if (Array.isArray(seed.agents)) {
    for (const agent of seed.agents) {
      if (!(await User.exists({ email: agent.email }))) {
        await User.create({
          email: agent.email,
          name: agent.name,
          phone: agent.phone,
          jobTitle: agent.jobTitle,
          roles: agent.roles?.length ? agent.roles : agent.jobTitle ? [agent.jobTitle] : [],
          passwordHash: await hashPassword(DEMO_PASSWORD),
          role: ROLES.AGENT,
          company: branch._id,
          organization: branch.organization,
          active: true,
        });
      }
    }
  }

  const clients = new Map();
  for (const [i, { key, ...client }] of seed.clients.entries()) {
    const created = daysAgo(40 - index * 6 - i * 5);
    clients.set(key, await Client.create({ ...client, company: branch._id, createdAt: created, updatedAt: created }));
  }
  for (const [i, d] of seed.designs.entries()) {
    const client = clients.get(d.client);
    const updated = daysAgo(i * 3 + index);
    await Design.create({
      company: branch._id,
      client: client._id,
      name: d.name,
      status: d.status,
      data: d.data || null,
      summary: { ...(d.summary || {}), address: d.data?.place.address || '' },
      createdAt: daysAgo(i * 3 + index + 4),
      updatedAt: updated,
    });
  }

  console.log(`  + ${seed.company.name}: ${tenant.orgAdminEmail ? `company admin ${tenant.orgAdminEmail}, branch owner ${tenant.branchOwnerEmail}` : `owner ${tenant.branchOwnerEmail} (no branches)`}`);
}

export async function seedDemoData() {
  for (const [index, seed] of COMPANIES.entries()) await seedCompany(seed, index);
}
