// What a staff (agent) account may do in its company workspace, beyond the installation steps assigned to it.
//
// A permission is `<area>:<action>`, e.g. "finances:create_bill". Staff get permissions through named roles the
// owner defines (e.g. "Accountant", reused across people) plus optional extra grants on one person; their effective
// permissions are the union, resolved on every request (services/permission.service.js), so a change applies at once.
//
// Rules:
//  - The company owner can do everything. Masters (units, categories' setup, installation step template, agent job
//    roles, pricing defaults, invoice numbering, branding), staff and roles management, integrations and the
//    subscription are owner-only and are not grantable.
//  - Any action in an area implies that area's `view` (applied whenever permissions are saved).
//  - Every action listed here is enforced by the API. Don't add one before the code that checks it.
//
// The frontend mirrors this file in frontend/src/lib/permissions.js; tests/permissions.test.js fails if they drift.

export const PERMISSION_CATALOG = {
  leads: {
    label: 'Leads',
    description: 'Meta, Google Ads and manually added leads — staff see the leads assigned to them unless they may view all',
    actions: {
      view: 'Assigned to them',
      view_all: 'View all',
      create: 'Add & import',
      change_status: 'Change status',
      update: 'Edit & set priority',
      assign: 'Assign',
      export: 'Export',
    },
  },
  proposals: {
    label: 'Proposals',
    description: 'Rooftop designs and proposals for clients',
    actions: {
      view: 'View',
      create: 'Create',
      update: 'Edit',
      change_status: 'Change status',
      change_client: 'Change client',
      share: 'Share link',
      delete: 'Delete',
    },
  },
  clients: {
    label: 'Clients',
    description: 'Client records',
    actions: {
      view: 'View',
      create: 'Create',
      update: 'Edit',
      manage_login: 'Portal login',
      delete: 'Delete',
    },
  },
  finances: {
    label: 'Finances',
    description: 'E-way bills, bills (payments) and invoices',
    actions: {
      view: 'View',
      create_eway_bill: 'Create e-way bill',
      create_bill: 'Create bill',
      create_invoice: 'Create invoice',
    },
  },
  inventory: {
    label: 'Inventory',
    description: 'Products, catalog categories, packages, installation charges, stock and suppliers',
    actions: {
      view: 'View',
      create: 'Create',
      update: 'Edit',
      delete: 'Delete',
    },
  },
  tasks: {
    label: 'Installations',
    description: 'Every installation, its steps and AMC visits — staff always see the steps and visits assigned to them',
    actions: {
      view: 'View all',
      create: 'Start',
      update: 'Edit steps',
      assign: 'Assign steps',
      change_status: 'Update step status',
      invoice_parts: 'Invoice parts used on AMC visits',
      delete: 'Delete',
    },
  },
  support: {
    label: 'Platform support',
    description: 'The company’s own tickets with the platform team',
    actions: {
      view: 'View',
      create: 'Create',
      update: 'Reply & close',
    },
  },
  helpdesk: {
    label: 'Client support',
    description: 'Help requests your clients send from the client portal',
    actions: {
      view: 'View',
      update: 'Reply & change status',
    },
  },
  expenses: {
    label: 'Expenses',
    description: 'What was spent on each proposal’s project, with the reason',
    actions: {
      view: 'View',
      create: 'Add expenses',
      update: 'Edit expenses',
      delete: 'Delete expenses',
    },
  },
  loans: {
    label: 'Loans',
    description: 'Clients who are buying with a loan, and their progress through the loan steps',
    actions: {
      view: 'View',
      update: 'Update loan & steps',
    },
  },
  subsidies: {
    label: 'Subsidies',
    description: 'Proposals with a government subsidy, and their progress through the subsidy steps',
    actions: {
      view: 'View',
      update: 'Update subsidy & steps',
    },
  },
};

export const PERMISSION_AREAS = Object.keys(PERMISSION_CATALOG);

/** Every valid permission string, e.g. "finances:create_bill". */
export const STAFF_PERMISSIONS = PERMISSION_AREAS.flatMap((area) => Object.keys(PERMISSION_CATALOG[area].actions).map((action) => `${area}:${action}`));

const VALID = new Set(STAFF_PERMISSIONS);
export const isPermission = (p) => VALID.has(p);

/** Unique, valid, sorted — and every action brings its area's `view` along. */
export function normalizePermissions(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const p = String(raw ?? '').trim();
    if (!VALID.has(p)) continue;
    out.add(p);
    out.add(`${p.split(':')[0]}:view`);
  }
  return [...out].sort();
}

/**
 * Starting points offered when the owner creates a role. They're copied into the company's own role (and can be
 * changed freely there); nothing is kept in sync with these afterwards.
 */
export const ROLE_TEMPLATES = [
  {
    key: 'telecaller',
    name: 'Telecaller',
    description: 'Calls the leads assigned to them and updates their status — can’t assign or export.',
    permissions: ['leads:view', 'leads:change_status'],
  },
  {
    key: 'lead_manager',
    name: 'Lead manager',
    description: 'Sees every lead, assigns them to telecallers and exports them.',
    permissions: ['leads:view_all', 'leads:create', 'leads:change_status', 'leads:update', 'leads:assign', 'leads:export'],
  },
  {
    key: 'sales',
    name: 'Sales executive',
    description: 'Works with clients and prepares proposals.',
    permissions: ['leads:view', 'leads:change_status', 'clients:view', 'clients:create', 'clients:update', 'proposals:view', 'proposals:create', 'proposals:update', 'proposals:change_status', 'proposals:share', 'inventory:view'],
  },
  {
    key: 'designer',
    name: 'Designer',
    description: 'Designs rooftop systems and prepares proposals.',
    permissions: ['proposals:view', 'proposals:create', 'proposals:update', 'clients:view', 'inventory:view'],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Makes e-way bills, bills and invoices.',
    permissions: ['finances:view', 'finances:create_eway_bill', 'finances:create_bill', 'finances:create_invoice', 'clients:view', 'proposals:view'],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    description: 'Takes payments on bills — no e-way bills or invoices.',
    permissions: ['finances:view', 'finances:create_bill'],
  },
  {
    key: 'invoicing',
    name: 'Invoicing clerk',
    description: 'Makes e-way bills and invoices — no payments.',
    permissions: ['finances:view', 'finances:create_eway_bill', 'finances:create_invoice'],
  },
  {
    key: 'storekeeper',
    name: 'Store keeper',
    description: 'Maintains products, packages and installation charges, and sends goods out on e-way bills.',
    permissions: ['inventory:view', 'inventory:create', 'inventory:update', 'finances:view', 'finances:create_eway_bill'],
  },
  {
    key: 'supervisor',
    name: 'Installation supervisor',
    description: 'Starts installations and manages their steps.',
    permissions: ['tasks:view', 'tasks:create', 'tasks:update', 'tasks:assign', 'tasks:change_status', 'proposals:view'],
  },
];

/**
 * How the permissions stored before roles existed translate into the current ones. Each old grant maps to whatever
 * now covers exactly what it allowed, so migrating changes nobody's access.
 */
export const LEGACY_PERMISSION_MAP = {
  'designs:view': ['proposals:view'],
  'designs:create': ['proposals:create'],
  'designs:update': ['proposals:update', 'proposals:change_status', 'proposals:change_client', 'proposals:share'],
  'designs:delete': ['proposals:delete'],
  'clients:view': ['clients:view'],
  'clients:create': ['clients:create'],
  'clients:update': ['clients:update', 'clients:manage_login'],
  'clients:delete': ['clients:delete'],
  'billing:view': ['finances:view'],
  'billing:create': ['finances:create_invoice'],
  'billing:update': [],
  'billing:delete': [],
  'installations:view': ['tasks:view'],
  'installations:create': ['tasks:create'],
  'installations:update': ['tasks:update', 'tasks:assign', 'tasks:change_status'],
  'installations:delete': ['tasks:delete'],
  'catalog:view': ['inventory:view'],
  'catalog:create': ['inventory:create'],
  'catalog:update': ['inventory:update'],
  'catalog:delete': ['inventory:delete'],
  'support:view': ['support:view'],
  'support:create': ['support:create'],
  'support:update': ['support:update'],
  'support:delete': [],
};

/**
 * Version of the permission names above. Accounts and roles saved before carry an older version (or none) and are
 * migrated once, so that nobody gains or loses access:
 *  - v1 (no version): the old names, see LEGACY_PERMISSION_MAP.
 *  - v2 → v3: "Edit" used to include changing a proposal's status and client, and assigning installation steps and
 *    updating their status; those became their own actions, given to everyone who had "Edit".
 *  - v3 → v4: invoices used to be made straight from a proposal; now goods go out on an e-way bill and are paid on a
 *    bill first, so whoever could create invoices can also create e-way bills and bills.
 *  - v4 → v5: receipts were removed (a bill is the payment), so "Record payment" and "Remove receipt" are dropped.
 */
export const PERMISSIONS_VERSION = 5;

const V3_SPLITS = {
  'proposals:update': ['proposals:change_status', 'proposals:change_client'],
  'tasks:update': ['tasks:assign', 'tasks:change_status'],
};
const V4_SPLITS = {
  'finances:create_invoice': ['finances:create_eway_bill', 'finances:create_bill'],
};

/** A permission list saved at `version` (1 = before versions existed) → the current names, with the same access. */
export function upgradePermissions(list, version = 1) {
  let out = version < 2 ? migrateLegacyPermissions(list) : [...new Set((Array.isArray(list) ? list : []).filter((p) => VALID.has(p)))];
  if (version < 3) out = [...new Set([...out, ...out.flatMap((p) => V3_SPLITS[p] || [])])];
  if (version < 4) out = [...new Set([...out, ...out.flatMap((p) => V4_SPLITS[p] || [])])];
  return out.filter((p) => VALID.has(p)).sort(); // names dropped since (v5: the receipt actions) fall away
}

/**
 * Old → current permission strings, for an account still on the old names. Some names exist in both (e.g.
 * "clients:update", which used to include managing the client's portal login), so this must run once per account —
 * see migrations/staffPermissions.migration.js. Anything unknown is dropped.
 */
export function migrateLegacyPermissions(list) {
  const out = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (LEGACY_PERMISSION_MAP[p]) LEGACY_PERMISSION_MAP[p].forEach((q) => out.add(q));
    else if (VALID.has(p)) out.add(p);
  }
  return [...out].sort(); // no implied `view` here: migrating must not widen anyone's access
}
