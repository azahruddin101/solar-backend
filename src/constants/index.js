export const ROLES = { SUPERADMIN: 'superadmin', COMPANY: 'company', AGENT: 'agent', CLIENT: 'client' };
/** Roles that belong to a company (tenant). Agents are the company's field staff. */
export const TENANT_ROLES = [ROLES.COMPANY, ROLES.AGENT, ROLES.CLIENT];
export const COMPANY_STATUS = ['active', 'suspended'];
export const PLANS = ['starter', 'growth', 'enterprise'];
export const DESIGN_STATUS = ['draft', 'proposed', 'reproposed', 'negotiation', 'won', 'lost'];
/** Sent to the client and still waiting on a decision (a quote, a revised quote, or one being haggled over). */
export const OPEN_DESIGN_STATUS = ['proposed', 'reproposed', 'negotiation'];
export const DESIGN_GRID_TYPES = ['on_grid', 'off_grid', 'hybrid'];
/** Client portal response to a proposed design (stored on the design until cleared on re-proposal). */
export const CLIENT_PROPOSAL_DECISION = ['accepted', 'rejected', 'changes_requested'];
export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'];
export const CLIENT_PROJECT_TYPES = ['residential', 'industrial', 'commercial'];
export const CLIENT_ROOF_TYPES = ['concrete', 'factory', 'tin_shed'];
export const PROJECT_STATUS = ['active', 'completed'];
/** Scheduled maintenance visit on an installation (from the company's AMC template). */
export const AMC_VISIT_STATUS = ['pending', 'completed'];
/** Client AMC booking: request → company assigns staff → field completion. */
export const AMC_REQUEST_STATUS = ['requested', 'assigned', 'completed', 'cancelled'];
/** A visit on the installation: free (included) visits are 'scheduled' automatically; paid packages follow the request flow. */
export const AMC_VISIT_WORKFLOW = ['scheduled', ...AMC_REQUEST_STATUS];
export const STEP_STATUS = ['pending', 'in_progress', 'done'];
/** A client's loan: being processed, then approved/disbursed (completed) or rejected. Its steps use STEP_STATUS. */
export const LOAN_STATUS = ['in_progress', 'completed', 'rejected'];
/** A proposal's government subsidy file: being processed, then credited (completed) or rejected. Its steps use STEP_STATUS. */
export const SUBSIDY_STATUS = ['in_progress', 'completed', 'rejected'];
// How urgent an installation step is. The company sets it per step; 'medium' unless it says otherwise.
export const STEP_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const DEFAULT_STEP_PRIORITY = 'medium';
export const STEP_STATUS_LABEL = { pending: 'Pending', in_progress: 'In progress', done: 'Done' };
// How the designer uses a category's products: 'panels' (watt + size) and 'poles' (shape, priced per foot)
// are picked up by the designer; 'general' products are catalog items (inverters, wire, earthing, ACDB, DCDB, etc.).
export const PRODUCT_TYPES = ['general', 'panels', 'poles'];
export const PILLAR_SHAPES = ['l-shape', 'cylindrical', 'square'];
// Category attribute definitions (Category.attributes): what kind of value each one holds on a product.
export const ATTRIBUTE_TYPES = ['text', 'number', 'select', 'boolean'];
// A serialized product's physical units (SerialUnit.status) and the moves allowed between them.
export const UNIT_STATUS = ['inStock', 'sold', 'installed', 'returned'];
export const UNIT_TRANSITIONS = { inStock: ['sold', 'installed'], sold: ['installed', 'returned'], installed: ['returned'], returned: ['inStock'] };
// Which batch price an invoice line is billed at (Batch.basePrice / wholesalePrice / retailPrice).
export const PRICE_TYPES = ['base', 'wholesale', 'retail'];
// The sale chain (services/ewayBill.service.js, bill.service.js): goods leave stock on an e-way bill, one or more
// e-way bills plus service charges are paid on a bill, and an invoice consolidates the bills.
export const EWAY_BILL_STATUS = ['open', 'billed', 'cancelled'];
export const BILL_STATUS = ['paid', 'invoiced', 'void'];
/** An invoice is `void` when it was struck off (its bills are free again); the number is never reused. */
export const INVOICE_STATUS = ['issued', 'void'];
/** `sale` is the invoice of a sale (made from bills); `amc_parts` bills parts replaced on an AMC visit and is not "the proposal's invoice". */
export const INVOICE_KIND = ['sale', 'amc_parts'];
export const TRANSPORT_MODES = ['road', 'rail', 'air', 'ship'];
export const TRANSPORT_REASONS = ['supply', 'job_work', 'own_use', 'exhibition', 'others'];
/** Default “per …” labels for catalog products; each company can change this list. */
export const DEFAULT_PRODUCT_UNITS = ['Piece', 'Nos', 'Set', 'Metre', 'Foot', 'Kg', 'Box', 'Roll', 'Lot', 'Bundle'];
/** Default job titles for field staff; each company can edit this list under Agent roles. */
export const DEFAULT_AGENT_ROLES = ['Site surveyor', 'Electrician', 'Installer', 'Supervisor', 'Inspector'];

// Staff permissions (`<area>:<action>`), roles and their templates live in permissions.js. Unrelated to
// `DEFAULT_AGENT_ROLES` above: a job title says which installation steps someone can be assigned; permissions
// say which parts of the company workspace they may use.
export { PERMISSION_AREAS, PERMISSION_CATALOG, STAFF_PERMISSIONS } from './permissions.js';

export const TICKET_STATUS = ['open', 'in_progress', 'resolved', 'closed'];
export const TICKET_STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
export const TICKET_CATEGORIES = ['technical', 'billing', 'account', 'other'];
export const TICKET_PRIORITIES = ['low', 'normal', 'high'];
/** What a client's help request (company ↔ client support) is about. */
export const CLIENT_TICKET_CATEGORIES = ['installation', 'service', 'billing', 'proposal', 'other'];
export const TICKET_FILE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const ASSET_KINDS = ['logo', 'signature', 'qr'];
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Starter catalog given to every new company so it can design right away.
export const DEFAULT_PANELS = [
  { brand: 'Waaree', model: 'WS-300', watts: 300, length: 1.65, width: 0.99, price: 7500, warrantyYears: 25 },
  { brand: 'Tata Power Solar', model: 'TP-400', watts: 400, length: 1.88, width: 1.05, price: 10500, warrantyYears: 25 },
  { brand: 'Adani Solar', model: 'ASM-500', watts: 500, length: 2.19, width: 1.1, price: 13500, warrantyYears: 30 },
];
export const DEFAULT_PILLARS = [
  { name: 'MS angle 50×50×5', shape: 'l-shape', pricePerFt: 95 },
  { name: 'GI round pipe 2"', shape: 'cylindrical', pricePerFt: 140 },
  { name: 'GI square tube 60×60', shape: 'square', pricePerFt: 165 },
];
// Starter categories for a complete rooftop solar system; companies can rename, remove, and add their own.
export const DEFAULT_CATEGORIES = [
  { name: 'Solar panels', type: 'panels', description: 'Modules used in the designer and printed on proposals.', specKeys: ['Cell type', 'Efficiency (%)', 'Cell count', 'Bifaciality'] },
  { name: 'Poles / pillars', type: 'poles', description: 'Mounting poles, priced per foot.', specKeys: ['Material', 'Coating', 'Thickness'] },
  { name: 'Inverters', description: 'On-grid, hybrid, and micro string inverters.', specKeys: ['Capacity (kW)', 'MPPT count', 'Phase', 'Max Efficiency (%)', 'Wi-Fi'] },
  { name: 'Wire & Cabling', description: 'Solar DC cable (4/6 sq.mm) and multi-core AC copper/aluminum cabling.', specKeys: ['Size (sq.mm)', 'Conductor', 'Insulation', 'Voltage rating'] },
  { name: 'Chemical Earthing Kit', description: 'Maintenance-free chemical earthing electrodes and compound.', specKeys: ['Electrode type', 'Length (m)', 'Diameter (mm)', 'Backfill compound'] },
  { name: 'ACDB Box', description: 'AC distribution box with MCB/MCCB, SPD, and energy meter provisions.', specKeys: ['Rating (A)', 'Phases', 'SPD Class', 'IP Rating'] },
  { name: 'DCDB Box', description: 'DC distribution box with 1000V DC fuses, SPD, and disconnect switch.', specKeys: ['Inputs / Outputs', 'Fuse rating (A)', 'SPD rating (kV)', 'Enclosure'] },
  { name: 'Mounting Structure / Hardware', description: 'Module mounting rails, mid/end clamps, fasteners, and brackets.', specKeys: ['Material', 'Hardware grade', 'Wind speed rating (km/h)'] },
  { name: 'Batteries & Energy Storage', description: 'Lithium Ferro Phosphate (LFP) and lead acid storage systems.', specKeys: ['Capacity (kWh)', 'Chemistry', 'Voltage (V)', 'Cycle life'] },
];

// Parent categories every company starts with, and the category names each one collects by default.
// The first one also takes the solar panel and pole categories.
export const DEFAULT_PARENT_CATEGORIES = [
  { name: 'Structures', description: 'Solar panels, poles and the mounting structure.', match: /panel|module|pole|pillar|mount|structure|rail|clamp/i },
  { name: 'Electricals', description: 'Inverters, cabling, protection and storage.', match: /inverter|wire|cabl|earth|acdb|dcdb|distribution|batter|storage|meter|mcb|mccb|spd|fuse|conduit|connector|lightning|electric/i },
];

// Suggested expense reasons; each company edits its own list (Company.expenseReasons).
export const DEFAULT_EXPENSE_REASONS = [
  'Transport of material',
  'Labour charges',
  'Material purchase',
  'Structure fabrication',
  'Electrical work',
  'Permits & net-metering fees',
  'Travel & site visit',
  'Tools & equipment',
  'Food & accommodation',
  'Repair / rework',
];
export const MAX_EXPENSE_REASONS = 50;

// Suggested loan steps; each company edits its own list (Company.loanSteps).
export const DEFAULT_LOAN_STEPS = [
  { name: 'Documents collected', description: 'ID proof, address proof, income proof, electricity bill and bank statements.' },
  { name: 'Application submitted', description: 'Loan application filed with the bank / lender.' },
  { name: 'Verification', description: 'Lender verifies documents and the site.' },
  { name: 'Loan sanctioned', description: 'Sanction letter received.' },
  { name: 'Loan disbursed', description: 'Amount released to the company.' },
];

// Suggested installation steps; each company edits its own list (Company.installationSteps).
export const DEFAULT_INSTALLATION_STEPS = [
  { name: 'Site inspection', description: 'Visit the site, verify roof measurements, shading and the electrical connection.', role: 'Site surveyor' },
  { name: 'Material procurement', description: 'Order and receive panels, inverter, structure and cabling.', role: 'Supervisor' },
  { name: 'Structure installation', description: 'Mount the pillars and the module mounting structure.', role: 'Installer' },
  { name: 'Panel & electrical installation', description: 'Fix the panels, run DC/AC cabling, install the inverter and earthing.', role: 'Electrician' },
  { name: 'Testing & handover', description: 'Commission the system, net-meter paperwork and hand over to the client.', role: 'Inspector' },
];

// Suggested subsidy steps (the PM Surya Ghar flow); each company edits its own list (Company.subsidySteps). New companies start with them.
export const DEFAULT_SUBSIDY_STEPS = [
  { name: 'Documents collected', description: 'Aadhaar, electricity bill, bank account details and roof ownership proof.' },
  { name: 'Registered on the portal', description: 'Client registered on the scheme portal with the DISCOM and consumer number.' },
  { name: 'Application approved', description: 'Feasibility approval received from the electricity company (DISCOM).' },
  { name: 'Installation reported', description: 'System installed and the installation details submitted on the portal.' },
  { name: 'Net meter & inspection', description: 'Net meter fitted and the DISCOM inspection done.' },
  { name: 'Commissioning & claim', description: 'Commissioning certificate issued and the subsidy claim submitted with the bank details.' },
  { name: 'Subsidy credited', description: 'Subsidy received in the client’s bank account.' },
];
