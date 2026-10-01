export const ROLES = { SUPERADMIN: 'superadmin', COMPANY: 'company', AGENT: 'agent', CLIENT: 'client' };
/** Roles that belong to a company (tenant). Agents are the company's field staff. */
export const TENANT_ROLES = [ROLES.COMPANY, ROLES.AGENT, ROLES.CLIENT];
export const COMPANY_STATUS = ['active', 'suspended'];
export const PLANS = ['starter', 'growth', 'enterprise'];
export const DESIGN_STATUS = ['draft', 'proposed', 'won', 'lost'];
export const DESIGN_GRID_TYPES = ['on_grid', 'off_grid'];
/** Client portal response to a proposed design (stored on the design until cleared on re-proposal). */
export const CLIENT_PROPOSAL_DECISION = ['accepted', 'rejected', 'changes_requested'];
export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'];
export const CLIENT_PROJECT_TYPES = ['residential', 'industrial', 'commercial'];
export const CLIENT_ROOF_TYPES = ['concrete', 'factory', 'tin_shed'];
export const PROJECT_STATUS = ['active', 'completed'];
export const STEP_STATUS = ['pending', 'in_progress', 'done'];
// How urgent an installation step is. The company sets it per step; 'medium' unless it says otherwise.
export const STEP_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const DEFAULT_STEP_PRIORITY = 'medium';
export const STEP_STATUS_LABEL = { pending: 'Pending', in_progress: 'In progress', done: 'Done' };
// How the designer uses a category's products: 'panels' (watt + size) and 'poles' (shape, priced per foot)
// are picked up by the designer; 'general' products are catalog items (inverters, wire, earthing, ACDB, DCDB, etc.).
export const PRODUCT_TYPES = ['general', 'panels', 'poles'];
export const PILLAR_SHAPES = ['l-shape', 'cylindrical', 'square'];
/** Default “per …” labels for catalog products; each company can change this list. */
export const DEFAULT_PRODUCT_UNITS = ['Piece', 'Nos', 'Set', 'Metre', 'Foot', 'Kg', 'Box', 'Roll', 'Lot', 'Bundle'];
/** Default job titles for field staff; each company can edit this list under Agent roles. */
export const DEFAULT_AGENT_ROLES = ['Site surveyor', 'Electrician', 'Installer', 'Supervisor', 'Inspector'];

/**
 * Company-level areas a staff (agent) account can be given access to, beyond their own assigned
 * installation steps. Unrelated to `agentRoles`/`roles` above (the job-title list used to match a
 * step's required role) — a staff member's job title says what work they do; permissions say which
 * parts of the company workspace they may open, and at what CRUD level (below).
 */
export const STAFF_PERMISSION_AREAS = ['designs', 'clients', 'billing', 'installations', 'support', 'catalog'];
export const STAFF_PERMISSION_AREA_LABEL = {
  designs: 'Proposals — rooftop designs and proposals for clients',
  clients: 'Clients — client records',
  billing: 'Billing — payments and invoices',
  installations: 'Installations — every installation, not just their own steps',
  catalog: 'Catalog — products, categories, packages, installation charges, units and pricing',
  support: 'Support — tickets with the platform',
};

/** CRUD level within a granted area. 'view' is required for any of the other three to have effect. */
export const STAFF_PERMISSION_ACTIONS = ['view', 'create', 'update', 'delete'];
export const STAFF_PERMISSION_ACTION_LABEL = { view: 'View', create: 'Create', update: 'Edit', delete: 'Delete' };

/** Every valid `<area>:<action>` permission string, e.g. "designs:create" — stored on User.permissions. */
export const STAFF_PERMISSIONS = STAFF_PERMISSION_AREAS.flatMap((area) => STAFF_PERMISSION_ACTIONS.map((action) => `${area}:${action}`));

export const TICKET_STATUS = ['open', 'in_progress', 'resolved', 'closed'];
export const TICKET_STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
export const TICKET_CATEGORIES = ['technical', 'billing', 'account', 'other'];
export const TICKET_PRIORITIES = ['low', 'normal', 'high'];
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

// Suggested installation steps; each company edits its own list (Company.installationSteps).
export const DEFAULT_INSTALLATION_STEPS = [
  { name: 'Site inspection', description: 'Visit the site, verify roof measurements, shading and the electrical connection.', role: 'Site surveyor' },
  { name: 'Material procurement', description: 'Order and receive panels, inverter, structure and cabling.', role: 'Supervisor' },
  { name: 'Structure installation', description: 'Mount the pillars and the module mounting structure.', role: 'Installer' },
  { name: 'Panel & electrical installation', description: 'Fix the panels, run DC/AC cabling, install the inverter and earthing.', role: 'Electrician' },
  { name: 'Testing & handover', description: 'Commission the system, net-meter paperwork and hand over to the client.', role: 'Inspector' },
];
