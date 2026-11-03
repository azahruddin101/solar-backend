/** QA tenant — sign in with TESTING_PASSWORD from the seeder entry script. */
export const TESTING_PASSWORD = 'Password@123';

export const TESTING_ORG_ADMIN = { email: 'testingcompany@gmail.com', name: 'Testing Company Admin' };

export const TESTING_MAIN_BRANCH = {
  name: 'Testing Company — Pune HQ',
  owner: { email: 'testingbranch@gmail.com', name: 'Testing Branch Owner' },
};

export const TESTING_EXTRA_BRANCHES = [
  { name: 'Testing Company — Mumbai', ownerEmail: 'testingbranch2@gmail.com', ownerName: 'Mumbai Branch Owner' },
  { name: 'Testing Company — Bengaluru', ownerEmail: 'testingbranch3@gmail.com', ownerName: 'Bengaluru Branch Owner' },
];

export const TESTING_COMPANY_PROFILE = {
  name: 'Testing Company Pvt Ltd',
  email: 'hello@testingcompany.test',
  phone: '9820098200',
  address: '501 Demo Tower, Baner, Pune, Maharashtra 411045',
  website: 'www.testingcompany.test',
  taxId: '27AAKCT1234E1Z5',
  pan: 'AAKCT1234E',
  theme: { primary: '#2563eb', accent: '#ea580c' },
  signatoryName: 'Testing Company Admin',
  signatoryTitle: 'Director',
  qrLabel: 'Scan for testing company',
  tagline: 'Solar QA tenant',
  currency: 'INR',
  tariff: 9.5,
  otherCostPerKw: 17500,
  notes: 'Seeded for manual QA — safe to wipe with npm run seed:testing -- --replace',
  productUnits: ['piece', 'nos', 'set', 'metre', 'foot', 'kg', 'box', 'roll', 'lot', 'bundle', 'panel'],
  pdfTerms: '<p>Demo proposal terms for the testing company.</p>',
};
