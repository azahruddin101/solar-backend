// Request schemas, one per form/endpoint. Objects are "loose": fields not listed here pass through untouched
// (the services still pick what they accept), while every listed field is checked and normalised.
import { PILLAR_SHAPES, PRODUCT_TYPES, STEP_STATUS, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS } from '../constants/index.js';
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

export const companySelfSchema = obj({
  ...companyProfile,
  signatoryName: f.personNameOptional,
  signatoryTitle: f.textOptional(80, 'Title'),
  qrLabel: f.textOptional(80, 'QR label'),
  tagline: f.textOptional(160, 'Tagline'),
  currency: f.currencyCode.optional(),
  tariff: f.num({ min: 0, max: 1000, label: 'Tariff' }).optional(),
  otherCostPerKw: f.num({ min: 0, max: 1e7, label: 'Other cost per kW' }).optional(),
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

export const agentCreateSchema = obj({ name: f.personNameRequired, email: f.emailRequired, password: f.newPassword, phone: f.phoneOptional, roles: strArray(10, 40).optional() });
export const agentUpdateSchema = obj({ name: f.personNameRequired, email: f.emailRequired, password: f.optionalNewPassword, phone: f.phoneOptional, roles: strArray(10, 40).optional() }).partial();

/* ───────────── catalog ───────────── */

export const categorySchema = obj({
  name: f.textRequired(60, 'Category name'),
  description: f.textOptional(300, 'Description'),
  type: z.enum(PRODUCT_TYPES, 'Invalid category type').optional(),
  specKeys: strArray(40).optional(),
});
export const categoryUpdateSchema = categorySchema.partial();

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
