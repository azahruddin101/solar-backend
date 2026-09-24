export const ROLES = { SUPERADMIN: 'superadmin', COMPANY: 'company', AGENT: 'agent' };
/** Roles that belong to a company (tenant). Agents are the company's field staff. */
export const TENANT_ROLES = [ROLES.COMPANY, ROLES.AGENT];
export const COMPANY_STATUS = ['active', 'suspended'];
export const PLANS = ['starter', 'growth', 'enterprise'];
export const DESIGN_STATUS = ['draft', 'proposed', 'won', 'lost'];
export const PROJECT_STATUS = ['active', 'completed'];
export const STEP_STATUS = ['pending', 'in_progress', 'done'];
export const STEP_STATUS_LABEL = { pending: 'Pending', in_progress: 'In progress', done: 'Done' };
// How the designer uses a category's products: 'panels' (watt + size) and 'poles' (shape, priced per foot)
// are picked up by the designer; 'general' products are catalog items (inverters, wire, earthing, ACDB, DCDB, etc.).
export const PRODUCT_TYPES = ['general', 'panels', 'poles'];
export const PILLAR_SHAPES = ['l-shape', 'cylindrical', 'square'];
/** Default “per …” labels for catalog products; each company can change this list. */
export const DEFAULT_PRODUCT_UNITS = ['Piece', 'Nos', 'Set', 'Metre', 'Foot', 'Kg', 'Box', 'Roll', 'Lot', 'Bundle'];
/** Default job titles for field staff; each company can edit this list under Agent roles. */
export const DEFAULT_AGENT_ROLES = ['Site surveyor', 'Electrician', 'Installer', 'Supervisor', 'Inspector'];

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

// Suggested installation steps; each company edits its own list (Company.installationSteps).
export const DEFAULT_INSTALLATION_STEPS = [
  { name: 'Site inspection', description: 'Visit the site, verify roof measurements, shading and the electrical connection.', role: 'Site surveyor' },
  { name: 'Material procurement', description: 'Order and receive panels, inverter, structure and cabling.', role: 'Supervisor' },
  { name: 'Structure installation', description: 'Mount the pillars and the module mounting structure.', role: 'Installer' },
  { name: 'Panel & electrical installation', description: 'Fix the panels, run DC/AC cabling, install the inverter and earthing.', role: 'Electrician' },
  { name: 'Testing & handover', description: 'Commission the system, net-meter paperwork and hand over to the client.', role: 'Inspector' },
];
