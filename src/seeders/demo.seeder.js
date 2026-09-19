// Demo tenants: companies with branding images, product catalog, clients and designs.
// Idempotent — a company whose sign-in email already exists is left untouched.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { ROLES } from '../constants/index.js';
import { Client, Company, Design, Panel, Pillar, User } from '../models/index.js';
import { publicPath } from '../services/asset.service.js';
import { hashPassword } from '../utils/password.js';
import { cleanRichText } from '../utils/richText.js';
import { drawLogo, drawQr, drawSignature } from './brandImages.js';
import { COMPANIES, DEMO_PASSWORD } from './data/companies.js';

async function writeBrandImages(company) {
  await fs.mkdir(env.uploadDir, { recursive: true });
  const website = company.website ? `https://${company.website.replace(/^https?:\/\//, '')}` : `mailto:${company.email}`;
  const images = { logo: drawLogo(company.theme), signature: drawSignature(company.signatoryName || company.name), qr: await drawQr(website) };
  for (const [kind, buffer] of Object.entries(images)) {
    const fileName = `${company.id}-${kind}-seed.png`; // same naming as multer uploads
    await fs.writeFile(path.join(env.uploadDir, fileName), buffer);
    company[kind] = publicPath(fileName);
  }
  await company.save();
}

/** Spread createdAt/updatedAt over the past weeks so lists and "time ago" labels look real. */
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

async function seedCompany(seed, index) {
  if (await User.exists({ email: seed.login.email })) return console.log(`  = ${seed.company.name} (already exists, skipped)`);

  const company = await Company.create({ ...seed.company, pdfTerms: cleanRichText(seed.company.pdfTerms || '') });
  await User.create({ email: seed.login.email, name: seed.login.name, passwordHash: await hashPassword(DEMO_PASSWORD), role: ROLES.COMPANY, company: company._id });
  await writeBrandImages(company);
  await Panel.insertMany(seed.panels.map((p) => ({ ...p, company: company._id })));
  await Pillar.insertMany(seed.pillars.map((p) => ({ ...p, company: company._id })));

  const clients = new Map();
  for (const [i, { key, ...client }] of seed.clients.entries()) {
    const created = daysAgo(40 - index * 6 - i * 5);
    clients.set(key, await Client.create({ ...client, company: company._id, createdAt: created, updatedAt: created }));
  }
  for (const [i, d] of seed.designs.entries()) {
    const client = clients.get(d.client);
    const updated = daysAgo(i * 3 + index);
    await Design.create({
      company: company._id,
      client: client._id,
      name: d.name,
      status: d.status,
      data: d.data || null,
      summary: { ...(d.summary || {}), address: d.data?.place.address || '' },
      createdAt: daysAgo(i * 3 + index + 4),
      updatedAt: updated,
    });
  }
  console.log(`  + ${seed.company.name}: ${seed.panels.length} panels, ${seed.clients.length} clients, ${seed.designs.length} designs → ${seed.login.email}`);
}

export async function seedDemoData() {
  for (const [index, seed] of COMPANIES.entries()) await seedCompany(seed, index);
}
