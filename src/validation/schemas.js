// Request schemas, one per form/endpoint. Objects are "loose": fields not listed here pass through untouched
// (the services still pick what they accept), while every listed field is checked and normalised.
import { CLIENT_PROJECT_TYPES, CLIENT_PROPOSAL_DECISION, CLIENT_ROOF_TYPES, PAYMENT_MODES, PILLAR_SHAPES, PRODUCT_TYPES, STAFF_PERMISSIONS, STEP_PRIORITIES, STEP_STATUS, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS } from '../constants/index.js';
import * as f from './common.js';

const { z } = f;
const obj = (shape) => z.looseObject(shape);
const strArray = (max, itemMax = 60) => z.array(z.string().trim().max(itemMax, `Each entry can be at most ${itemMax} characters`)).max(max, `Up to ${max} entries`);

/* ───────────── auth ───────────── */

export const loginSchema = obj({ email: f.emailRequired, password: f.loginPassword });
export const profileSchema = obj({ name: f.personNameOptional });
export const passwordChangeSchema = obj({ current: f.loginPassword, next: f.newPassword });

/* ───────────── clients ───────────── */

export const clientSchema = obj({
  name: f.orgNameRequired,
  email: f.emailOptional,
  phone: f.phoneOptional,
  pan: f.panOptional,
  gstNumber: f.gstinOptional,
  projectType: z.enum(CLIENT_PROJECT_TYPES).optional(),
  roofType: z.union([z.enum(CLIENT_ROOF_TYPES), z.literal('')]).optional(),
  address: f.textOptional(400, 'Address'),
  notes: f.textOptional(1000, 'Notes'),
  consumerNumber: f.consumerNumberOptional,
  kwRequired: f.numOptional({ min: 0.1, max: 100000, label: 'Required kW' }),
  source: f.textOptional(80, 'Source'),
  referredBy: obj({ name: f.personNameOptional, phone: f.phoneOptional }).optional(),
});
export const clientUpdateSchema = clientSchema.partial();

/* ───────────── company / admin ───────────── */

const companyProfile = {
  name: f.orgNameRequired,
  email: f.emailOptional,
  phone: f.phoneOptional,
  address: f.textOptional(400, 'Address'),
  website: f.websiteOptional,
  taxId: f.gstinOptional,
  pan: f.panOptional,
};

/** Invoice numbers: fixed part + next running number typed with its leading zeros ("INVCMP2026" + "0001"). */
const invoiceNumbering = obj({
  prefix: f.invoicePrefixOptional,
  next: f.invoiceNextRequired,
});

export const companySelfSchema = obj({
  ...companyProfile,
  invoiceNumbering: invoiceNumbering.optional(),
  signatoryName: f.personNameOptional,
  signatoryTitle: f.textOptional(80, 'Title'),
  qrLabel: f.textOptional(80, 'QR label'),
  tagline: f.textOptional(160, 'Tagline'),
  currency: f.currencyCode.optional(),
  tariff: f.num({ min: 0, max: 1000, label: 'Tariff' }).optional(),
  otherCostPerKw: f.num({ min: 0, max: 1e7, label: 'Other cost per kW' }).optional(),
}).partial();

/** The narrow slice of company settings a staff member with the "catalog" permission may change. */
export const catalogSettingsSchema = obj({
  currency: f.currencyCode.optional(),
  tariff: f.num({ min: 0, max: 1000, label: 'Tariff' }).optional(),
  otherCostPerKw: f.num({ min: 0, max: 1e7, label: 'Other cost per kW' }).optional(),
  productUnits: strArray(30, 20).optional(),
}).partial();

const limits = obj({
  maxClients: f.num({ min: 1, max: 1e6, int: true, label: 'Max clients' }).optional(),
  maxDesigns: f.num({ min: 1, max: 1e6, int: true, label: 'Max designs' }).optional(),
  maxConcurrentLogins: f.num({ min: 1, max: 1000, int: true, label: 'Concurrent logins' }).optional(),
});

export const adminCompanyCreateSchema = obj({
  ...companyProfile,
  loginEmail: f.emailRequired,
  password: f.newPassword,
  contactName: f.personNameOptional,
  notes: f.textOptional(1000, 'Notes'),
  limits: limits.optional(),
});
export const adminCompanyUpdateSchema = obj({ ...companyProfile, notes: f.textOptional(1000, 'Notes'), limits: limits.optional() }).partial();
export const passwordResetSchema = obj({ password: f.newPassword });

export const planSchema = obj({
  name: f.orgNameRequired,
  description: f.textOptional(300, 'Description'),
  priceMonthly: f.num({ min: 0, max: 1e7, label: 'Monthly price' }).optional(),
  maxClients: f.num({ min: 1, max: 1e6, int: true, label: 'Max clients' }).optional(),
  maxDesigns: f.num({ min: 1, max: 1e6, int: true, label: 'Max designs' }).optional(),
  maxConcurrentLogins: f.num({ min: 1, max: 1000, int: true, label: 'Concurrent logins' }).optional(),
  features: z.array(z.string().trim().max(100, 'A feature can be at most 100 characters')).max(20, 'A plan can list up to 20 features').optional(),
});
export const planUpdateSchema = planSchema.partial();

/* ───────────── agents ───────────── */

export const agentCreateSchema = obj({ name: f.personNameRequired, email: f.emailRequired, password: f.newPassword, phone: f.phoneOptional, roles: strArray(10, 40).optional(), permissions: strArray(STAFF_PERMISSIONS.length, 30).optional() });
export const agentUpdateSchema = obj({ name: f.personNameRequired, email: f.emailRequired, password: f.optionalNewPassword, phone: f.phoneOptional, roles: strArray(10, 40).optional(), permissions: strArray(STAFF_PERMISSIONS.length, 30).optional() }).partial();

/* ───────────── catalog ───────────── */

export const categorySchema = obj({
  name: f.textRequired(60, 'Category name'),
  description: f.textOptional(300, 'Description'),
  type: z.enum(PRODUCT_TYPES, 'Invalid category type').optional(),
  specKeys: strArray(40).optional(),
  parent: z.union([f.objectIdString, z.literal(''), z.null()]).optional(), // '' or null: not under any parent category
});
export const categoryUpdateSchema = categorySchema.partial();

export const parentCategorySchema = obj({
  name: f.textRequired(60, 'Parent category name'),
  description: f.textOptional(300, 'Description'),
});
export const parentCategoryUpdateSchema = parentCategorySchema.partial();

const spec = obj({ key: z.string().trim().max(60, 'Specification name is too long'), value: z.string().trim().max(200, 'Specification value is too long').optional() });
const year = new Date().getFullYear() + 1;

export const productSchema = obj({
  category: f.objectIdString,
  name: f.textOptional(120, 'Product name'),
  brand: f.textOptional(60, 'Brand'),
  model: f.textOptional(60, 'Model'),
  sku: f.skuOptional,
  hsnCode: f.hsnOptional,
  unit: f.textOptional(20, 'Unit'),
  price: f.numOptional({ min: 0, max: 1e9, label: 'Price' }),
  gstPercent: f.numOptional({ min: 0, max: 100, label: 'GST %' }),
  quantity: f.numOptional({ min: 0, max: 1e9, label: 'Quantity' }),
  warrantyYears: f.numOptional({ min: 0, max: 60, int: true, label: 'Warranty' }),
  description: f.textOptional(1000, 'Description'),
  watts: f.numOptional({ min: 1, max: 2000, label: 'Watt' }),
  manufactureYear: f.numOptional({ min: 1990, max: year, int: true, label: 'Manufacture year' }),
  length: f.numOptional({ min: 0.2, max: 5, label: 'Length' }),
  width: f.numOptional({ min: 0.2, max: 5, label: 'Width' }),
  shape: z.enum(PILLAR_SHAPES, 'Invalid shape').optional(),
  specs: z.array(spec).max(40, 'A product can have up to 40 specifications').optional(),
});
export const productUpdateSchema = productSchema.partial();

const packageItem = obj({ productId: f.objectIdString, qty: f.num({ min: 0, max: 1e6, label: 'Quantity' }), unit: f.textOptional(20, 'Unit') });
export const packageSchema = obj({
  name: f.textRequired(120, 'Package name'),
  kw: f.numOptional({ min: 0, max: 100000, label: 'Capacity (kW)' }),
  price: f.num({ min: 0, max: 1e10, label: 'Price' }),
  description: f.textOptional(1000, 'Description'),
  items: z.array(packageItem).max(100, 'A package can have up to 100 lines').optional(),
});

/* ───────────── installations ───────────── */

const stepFields = {
  name: f.textRequired(80, 'Step name'),
  description: f.textOptional(400, 'Description'),
  role: f.textOptional(40, 'Role'),
  assignee: f.objectIdOrBlank,
  priority: z.enum(STEP_PRIORITIES, 'Invalid step priority').optional(),
};
export const stepCreateSchema = obj(stepFields);
export const stepUpdateSchema = obj({
  ...stepFields,
  status: z.enum(STEP_STATUS, 'Invalid step status').optional(),
  move: z.enum(['up', 'down']).optional(),
  message: f.textOptional(1000, 'Message'),
  lat: f.lat.optional(),
  lng: f.lng.optional(),
}).partial();
export const agentStepStatusSchema = obj({
  status: z.enum(STEP_STATUS, 'Invalid step status'),
  message: f.textOptional(1000, 'Message'),
  lat: f.lat.optional(),
  lng: f.lng.optional(),
});
export const noteSchema = obj({ message: f.textRequired(1000, 'Note') });
export const projectStartSchema = obj({ design: f.objectIdString });

/* ───────────── support tickets (fields arrive as multipart text) ───────────── */

export const ticketCreateSchema = obj({
  subject: f.textRequired(150, 'Subject').refine((v) => v.length >= 3, 'Subject must be at least 3 characters'),
  body: f.textOptional(4000, 'Message'),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
});
export const ticketMessageSchema = obj({ body: f.textOptional(4000, 'Message') });
export const ticketStatusSchema = obj({ status: z.enum(TICKET_STATUS, 'Invalid ticket status') });

/* ───────────── designs ───────────── */

export const designCreateSchema = obj({ client: f.objectIdString, name: f.textOptional(120, 'Design name') });

export const designSendForReviewSchema = obj({
  message: f.textOptional(2000, 'Message to client'),
});

export const portalProposalResponseSchema = obj({
  decision: z.enum(CLIENT_PROPOSAL_DECISION, 'Choose accept, reject, or request changes'),
  note: f.textRequired(2000, 'Note'),
});

/* ───────────── plan requests ───────────── */

const requestedLimits = obj({
  maxClients: f.num({ min: 1, max: 100000, int: true, label: 'Clients' }).optional(),
  maxDesigns: f.num({ min: 1, max: 100000, int: true, label: 'Designs' }).optional(),
  maxConcurrentLogins: f.num({ min: 1, max: 500, int: true, label: 'Concurrent sign-ins' }).optional(),
});
export const planRequestSchema = obj({
  type: z.enum(['preset', 'custom'], 'Choose a plan type'),
  planId: f.objectIdOrBlank,
  message: f.textOptional(2000, 'Message'),
  requestedLimits: requestedLimits.optional(),
});
export const planRequestApproveSchema = obj({
  planName: f.textOptional(80, 'Plan name'),
  maxClients: f.numOptional({ min: 1, max: 100000, int: true, label: 'Clients' }),
  maxDesigns: f.numOptional({ min: 1, max: 100000, int: true, label: 'Designs' }),
  maxConcurrentLogins: f.numOptional({ min: 1, max: 500, int: true, label: 'Concurrent sign-ins' }),
  priceMonthly: f.numOptional({ min: 0, max: 1e7, label: 'Monthly price' }),
  periodDays: f.numOptional({ min: 1, max: 366, int: true, label: 'Period (days)' }),
  adminNotes: f.textOptional(2000, 'Notes'),
});
export const planRequestRejectSchema = obj({ adminNotes: f.textOptional(2000, 'Notes') });

/* ───────────── installation charges ───────────── */

export const installationChargeSchema = obj({
  name: f.textRequired(80, 'Charge name'),
  description: f.textOptional(300, 'Description'),
  defaultPrice: f.numOptional({ min: 0, max: 1e9, label: 'Default price' }),
  gstPercent: f.numOptional({ min: 0, max: 100, label: 'GST %' }),
});

/* ───────────── billing ───────────── */

export const paymentSchema = obj({
  amount: f.num({ min: 0.01, max: 1e10, label: 'Amount' }),
  mode: z.enum(PAYMENT_MODES, 'Choose how the payment was made'),
  reference: f.textOptional(80, 'Reference'),
  note: f.textOptional(300, 'Note'),
  receivedOn: z.string().optional(),
});

export const invoiceCreateSchema = obj({
  pricing: z.any().optional(),
  termsAndConditions: f.textOptional(30000, 'Terms and Conditions'),
});

/** An invoice with no proposal: who it is for, a title, and the priced lines. `client` optionally links an existing client. */
export const directInvoiceSchema = obj({
  client: z.string().optional().nullable(),
  billTo: obj({
    name: f.orgNameRequired,
    phone: f.phoneOptional,
    email: f.emailOptional,
    address: f.textOptional(400, 'Address'),
    gstNumber: f.gstinOptional,
  }),
  title: f.textOptional(160, 'Title'),
  pricing: z.any(),
  termsAndConditions: f.textOptional(30000, 'Terms and Conditions'),
});
