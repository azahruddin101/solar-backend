// Multi-branch QA tenant with full demo data on every branch and a shared org catalog.
//   npm run seed:testing
//   npm run seed:testing -- --replace
import {
  DEFAULT_EXPENSE_REASONS,
  DEFAULT_INSTALLATION_STEPS,
  DEFAULT_LOAN_STEPS,
  DEFAULT_SUBSIDY_STEPS,
  ROLES,
} from '../constants/index.js';
import { Company, Organization, Plan, User } from '../models/index.js';
import { applyPlanLimitsToCompany } from '../services/plan.service.js';
import { deleteCompany } from '../services/company.service.js';
import { cleanRichText } from '../utils/richText.js';
import { seedBranchShowcaseData } from './branchShowcase.seed.js';
import { writeBrandImages } from './demo.seeder.js';
import {
  TESTING_COMPANY_PROFILE,
  TESTING_EXTRA_BRANCHES,
  TESTING_MAIN_BRANCH,
  TESTING_ORG_ADMIN,
  TESTING_PASSWORD,
} from './data/testingCompany.js';
import { seedOrgTenant } from './orgTenant.seeder.js';
import { ensureDefaultPlans } from './plans.seeder.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

async function removeTestingOrganization() {
  const admin = await User.findOne({ email: TESTING_ORG_ADMIN.email });
  if (!admin?.organization) return false;
  const branches = await Company.find({ organization: admin.organization }).sort({ createdAt: -1 }).lean();
  for (const b of branches) await deleteCompany(b._id);
  return true;
}

export async function seedTestingCompany({ replace = false } = {}) {
  await ensureDefaultPlans();

  const existing = await User.findOne({ email: TESTING_ORG_ADMIN.email });
  if (existing) {
    if (!replace) {
      console.log('  = Testing company already exists (use --replace to recreate)');
      return null;
    }
    await removeTestingOrganization();
    console.log('  - removed existing testing company');
  }

  const tenant = await seedOrgTenant({
    login: TESTING_ORG_ADMIN,
    company: TESTING_COMPANY_PROFILE,
    password: TESTING_PASSWORD,
    branchName: TESTING_MAIN_BRANCH.name,
    hasBranches: true,
    branchOwner: TESTING_MAIN_BRANCH.owner,
    maxBranches: 5,
    extraBranches: TESTING_EXTRA_BRANCHES.map((b) => ({
      name: b.name,
      ownerEmail: b.ownerEmail,
      ownerName: b.ownerName,
      ownerPassword: TESTING_PASSWORD,
    })),
  });

  if (!tenant) {
    console.log('  = Could not create tenant (login email may already exist under another org)');
    return null;
  }

  const org = tenant.org;
  org.pdfTerms = cleanRichText(TESTING_COMPANY_PROFILE.pdfTerms);
  org.installationSteps = DEFAULT_INSTALLATION_STEPS;
  org.loanSteps = DEFAULT_LOAN_STEPS.map((s) => ({ ...s }));
  org.subsidySteps = DEFAULT_SUBSIDY_STEPS.map((s) => ({ ...s }));
  org.expenseReasons = [...DEFAULT_EXPENSE_REASONS];
  org.amcTemplates = [
    {
      name: '6-month health check',
      daysAfterInstallation: 180,
      kind: 'mandatory',
      price: 0,
      description: 'Cleaning, torque check and generation review.',
      criteria: ['Panel cleaning', 'Inverter fault log'],
    },
    {
      name: 'Annual service',
      daysAfterInstallation: 365,
      kind: 'mandatory',
      price: 1500,
      description: 'Full annual maintenance visit.',
      criteria: ['Earthing test', 'Cable inspection'],
    },
  ];
  const plan = await Plan.findOne({ code: 'pro' });
  if (plan) {
    org.planRef = plan._id;
    applyPlanLimitsToCompany(org, plan);
    org.limits.maxBranches = 5;
    org.limits.maxClients = Math.max(org.limits.maxClients || 0, 500);
    org.limits.maxDesigns = Math.max(org.limits.maxDesigns || 0, 500);
    org.subscription = { periodStart: daysAgo(30), periodEnd: daysAgo(-335) };
  }
  await org.save();

  const branches = await Company.find({ organization: org._id }).sort({ createdAt: 1 });
  await writeBrandImages(branches[0]);

  let sharedSku;
  for (const [index, branch] of branches.entries()) {
    const owner = await User.findOne({ company: branch._id, role: ROLES.BRANCH });
    if (!owner) throw new Error(`No branch owner for ${branch.name}`);
    owner.lastLoginAt = daysAgo(index);
    await owner.save();

    const { bySku } = await seedBranchShowcaseData({
      company: branch,
      owner,
      password: TESTING_PASSWORD,
      bySku: sharedSku,
      seedCatalog: index === 0,
      branchTag: `b${index + 1}`,
      branchIndex: index,
      agentDomain: 'testingcompany.test',
      platformTickets: index === 0,
    });
    if (index === 0) sharedSku = bySku;
    console.log(`  + ${branch.name}: clients, designs, installs, leads, billing, stock`);
  }

  const orgAdmin = await User.findOne({ email: TESTING_ORG_ADMIN.email });
  if (orgAdmin) {
    orgAdmin.lastLoginAt = daysAgo(0);
    await orgAdmin.save();
  }

  console.log(`  + ${TESTING_COMPANY_PROFILE.name}: ${branches.length} branches, shared product catalog`);
  return { org, branches };
}
