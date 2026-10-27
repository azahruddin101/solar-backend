// Request schemas, one per form/endpoint. Objects are "loose": fields not listed here pass through untouched
// (the services still pick what they accept), while every listed field is checked and normalised.
import { ATTRIBUTE_TYPES, PRICE_TYPES, UNIT_STATUS, CLIENT_PROJECT_TYPES, CLIENT_PROPOSAL_DECISION, CLIENT_ROOF_TYPES, PAYMENT_MODES, PILLAR_SHAPES, PRODUCT_TYPES, STAFF_PERMISSIONS, LOAN_STATUS, STEP_PRIORITIES, STEP_STATUS, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS, CLIENT_TICKET_CATEGORIES } from '../constants/index.js';
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

/* ───────────── expenses ───────────── */

export const expenseSchema = obj({
  amount: f.num({ min: 0.01, max: 1e10, label: 'Amount' }),
  reason: f.textRequired(300, 'Reason'),
  note: f.textOptional(500, 'Note'),
  spentOn: z.string().trim().optional(),
});
export const projectBudgetSchema = obj({
  amount: f.num({ min: 0.01, max: 1e10, label: 'Budget' }),
  note: f.textOptional(300, 'Note'),
});

/* ───────────── loans ───────────── */

export const loanStepsSchema = obj({
  steps: z.array(obj({ name: f.textRequired(80, 'Step name'), description: f.textOptional(400, 'Description') })).max(30, 'You can have up to 30 steps'),
});
export const loanUpdateSchema = obj({
  status: z.enum(LOAN_STATUS, 'Invalid loan status').optional(),
  lender: f.textOptional(120, 'Bank / lender'),
  amount: f.numOptional({ min: 0, max: 1e10, label: 'Loan amount' }),
  notes: f.textOptional(1000, 'Notes'),
});
export const loanStepUpdateSchema = obj({
  status: z.enum(STEP_STATUS, 'Invalid step status').optional(),
  remark: f.textOptional(500, 'Remark'),
});
export const loanDocumentRenameSchema = obj({ name: f.textRequired(200, 'Document name') });

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

const permissionList = z.array(z.enum(STAFF_PERMISSIONS, { error: 'Unknown permission' })).max(STAFF_PERMISSIONS.length);
// `roles` are job titles (which installation steps someone can be assigned); `staffRoles` are permission roles (ids)
export const agentCreateSchema = obj({ name: f.personNameRequired, email: f.emailRequired, password: f.newPassword, phone: f.phoneOptional, roles: strArray(10, 40).optional(), staffRoles: strArray(10, 24).optional(), permissions: permissionList.optional() });
export const agentUpdateSchema = obj({ name: f.personNameRequired, email: f.emailRequired, password: f.optionalNewPassword, phone: f.phoneOptional, roles: strArray(10, 40).optional(), staffRoles: strArray(10, 24).optional(), permissions: permissionList.optional() }).partial();

/* ───────────── staff roles ───────────── */

export const roleCreateSchema = obj({ name: f.textRequired(60, 'Role name'), description: f.textOptional(200, 'Description'), permissions: permissionList });
export const roleUpdateSchema = roleCreateSchema.partial();

/* ───────────── catalog ───────────── */

export const categorySchema = obj({
  name: f.textRequired(60, 'Category name'),
  description: f.textOptional(300, 'Description'),
  type: z.enum(PRODUCT_TYPES, 'Invalid category type').optional(),
  attributes: z.array(obj({
    key: f.textOptional(40, 'Attribute key'),
    label: f.textRequired(60, 'Attribute label'),
    dataType: z.enum(ATTRIBUTE_TYPES, 'Invalid attribute type').optional(),
    isRequired: z.boolean().optional(),
    options: strArray(50).optional(),
    sortOrder: f.numOptional({ min: 0, max: 1000, label: 'Order' }),
  })).max(40, 'A category can have up to 40 attributes').optional(),
  parent: z.union([f.objectIdString, z.literal(''), z.null()]).optional(), // '' or null: not under any parent category
});
export const categoryUpdateSchema = categorySchema.partial();

export const parentCategorySchema = obj({
  name: f.textRequired(60, 'Parent category name'),
  description: f.textOptional(300, 'Description'),
});
export const parentCategoryUpdateSchema = parentCategorySchema.partial();

const attributeValue = z.union([z.string().max(200, 'Attribute values can be at most 200 characters'), z.number(), z.boolean(), z.null()]);

// No prices, stock or manufacture year here: those belong to batches (stockReceiveSchema)
export const productSchema = obj({
  category: f.objectIdString,
  name: f.textOptional(120, 'Product name'),
  brand: f.textOptional(60, 'Brand'),
  model: f.textOptional(60, 'Model'),
  sku: f.skuOptional,
  hsnCode: f.hsnOptional,
  unit: f.textOptional(20, 'Unit'),
  gstPercent: f.numOptional({ min: 0, max: 100, label: 'GST %' }),
  warrantyMonths: f.numOptional({ min: 0, max: 720, int: true, label: 'Warranty' }),
  warrantyYears: f.numOptional({ min: 0, max: 60, label: 'Warranty' }), // older clients; converted to months
  reorderLevel: f.numOptional({ min: 0, max: 1e9, label: 'Reorder level' }),
  isSerialized: z.boolean().optional(),
  description: f.textOptional(1000, 'Description'),
  attributes: z.record(z.string().max(40), attributeValue).optional(),
  watts: f.numOptional({ min: 1, max: 2000, label: 'Watt' }),
  length: f.numOptional({ min: 0.2, max: 5, label: 'Length' }),
  width: f.numOptional({ min: 0.2, max: 5, label: 'Width' }),
  shape: z.enum(PILLAR_SHAPES, 'Invalid shape').optional(),
});
export const productUpdateSchema = productSchema.partial();

/* ───────────── stock ───────────── */

export const supplierSchema = obj({
  name: f.orgNameRequired,
  phone: f.phoneOptional,
  email: f.emailOptional,
  gstNumber: f.gstinOptional,
  address: f.textOptional(400, 'Address'),
  notes: f.textOptional(500, 'Notes'),
  categories: z.array(f.objectIdString).max(100, 'Choose up to 100 categories').optional(),
});
export const supplierUpdateSchema = supplierSchema.partial();

const year = new Date().getFullYear() + 1;
const dateOptional = z.preprocess((v) => (v === '' ? null : v), z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date').nullable().optional());
const batchFields = {
  supplier: f.objectIdString,
  batchNo: f.textOptional(60, 'Batch number'),
  mfgDate: dateOptional,
  mfgYear: f.numOptional({ min: 1990, max: year, int: true, label: 'Manufacture year' }),
  receivedDate: dateOptional,
  purchasePrice: f.numOptional({ min: 0, max: 1e10, label: 'Purchase price' }),
  basePrice: f.num({ min: 0, max: 1e10, label: 'Base price' }),
  wholesalePrice: f.num({ min: 0, max: 1e10, label: 'Wholesale price' }),
  retailPrice: f.num({ min: 0, max: 1e10, label: 'Retail price' }),
  note: f.textOptional(300, 'Note'),
};
/** Receiving stock: all three selling prices are required; serialized products send their serial numbers instead of a quantity. */
export const stockReceiveSchema = obj({
  ...batchFields,
  qtyReceived: f.numOptional({ min: 0, max: 1e7, label: 'Quantity' }),
  serials: strArray(2000, 80).optional(),
});
export const batchUpdateSchema = obj(batchFields).partial();
export const unitStatusSchema = obj({
  status: z.enum(UNIT_STATUS, 'Invalid status'),
  project: f.objectIdOrBlank,
  installDate: dateOptional,
});

const stockLine = {
  productId: f.objectIdString,
  qty: f.numOptional({ min: 0, max: 1e7, label: 'Quantity' }),
  batch: f.objectIdOrBlank, // blank: oldest batches first (FIFO)
  serials: strArray(2000, 80).optional(),
};
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

const amcTemplateRow = obj({
  name: f.textRequired(80, 'AMC name'),
  daysAfterInstallation: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
    z.number().int().min(1).max(3650).nullable().optional(),
  ),
  kind: z.enum(['mandatory', 'optional']).optional(),
  price: f.num({ min: 0, max: 1e9, label: 'Price' }).optional(),
  description: z.string().max(30000).optional(),
  criteria: strArray(40, 200).optional(),
}).superRefine((row, ctx) => {
  const kind = row.kind === 'optional' ? 'optional' : 'mandatory';
  if (kind === 'mandatory' && (row.daysAfterInstallation == null || !Number.isFinite(row.daysAfterInstallation))) {
    ctx.addIssue({ code: 'custom', message: 'Days after installation is required for mandatory visits', path: ['daysAfterInstallation'] });
  }
});
export const amcTemplatesSchema = obj({ templates: z.array(amcTemplateRow).max(20, 'Up to 20 AMC schedules') });
export const portalAmcRequestSchema = obj({
  packageName: f.textRequired(80, 'Package'),
  requestedDate: z.string().trim().min(1, 'Choose a preferred date'),
  note: f.textOptional(500, 'Note'),
  requestId: f.objectIdOrBlank, // change the date of this booking instead of making a new one
});
/** The company adds a visit to an installation. */
export const amcVisitCreateSchema = obj({
  name: f.textRequired(80, 'AMC'),
  date: z.string().trim().min(1, 'Choose a date'),
  note: f.textOptional(500, 'Note'),
  assigneeId: f.objectIdOrBlank,
});
export const amcRequestAssignSchema = obj({
  assigneeId: f.objectIdString,
});
export const amcVisitCompleteSchema = obj({
  note: f.textOptional(1000, 'Note'),
  criteria: z.array(obj({
    id: f.objectIdString,
    checked: z.boolean().optional(),
    note: f.textOptional(300, 'Note'),
  })).optional(),
});

/** Parts replaced on an AMC visit, taken from stock and invoiced to the client. */
export const amcPartsInvoiceSchema = obj({
  lines: z.array(obj({ ...stockLine, priceType: z.enum(PRICE_TYPES, 'Choose base, wholesale or retail price').optional() })).min(1, 'Add at least one part').max(50, 'Up to 50 parts'),
  withGst: z.boolean().optional(),
  note: f.textOptional(300, 'Note'),
});

/* ───────────── support tickets (fields arrive as multipart text) ───────────── */

export const ticketCreateSchema = obj({
  subject: f.textRequired(150, 'Subject').refine((v) => v.length >= 3, 'Subject must be at least 3 characters'),
  body: f.textOptional(4000, 'Message'),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
});
export const ticketMessageSchema = obj({ body: f.textOptional(4000, 'Message') });
export const ticketStatusSchema = obj({ status: z.enum(TICKET_STATUS, 'Invalid ticket status') });

/* client support: company ↔ client (fields arrive as multipart text) */
export const clientTicketCreateSchema = obj({
  subject: f.textRequired(150, 'Subject').refine((v) => v.length >= 3, 'Subject must be at least 3 characters'),
  body: f.textOptional(4000, 'Message'),
  category: z.enum(CLIENT_TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  clientId: f.objectIdString.optional(), // the company starting a conversation with one of its clients
});

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

const invoiceLineSchema = obj({
  name: f.textRequired(160, 'Line item name'),
  detail: f.textOptional(600, 'Detail'),
  hsn: f.hsnOptional,
  qty: f.numOptional({ min: 0, max: 1e6, label: 'Quantity' }),
  unit: f.textOptional(20, 'Unit'),
  rate: f.num({ min: 0, max: 1e10, label: 'Rate' }), // a product line is priced from its batch instead
  gstPercent: f.numOptional({ min: 0, max: 100, label: 'GST %' }),
  // a line sold from stock (see stock.service.js allocateInvoiceLines)
  productId: f.objectIdString.optional(),
  priceType: z.enum(PRICE_TYPES, 'Choose base, wholesale or retail price').optional(),
  batch: f.objectIdOrBlank,
  serials: strArray(2000, 80).optional(),
});

/** Line items and discount flags; totals are recomputed on the server (BIZ-001). */
export const invoicePricingInputSchema = obj({
  lines: z.array(invoiceLineSchema).min(1, 'Add at least one line item').max(100),
  discount: f.numOptional({ min: 0, max: 1e10, label: 'Discount' }),
  discountIsPercent: z.boolean().optional(),
  discountRemark: f.textOptional(200, 'Discount remark'),
  gstIncluded: z.boolean().optional(),
  withGst: z.boolean().optional(),
  invoiceGstMode: z.enum(['with_gst', 'without_gst']).optional(),
  paymentTerms: f.textOptional(120, 'Payment terms'),
});

/** Optional reference and delivery details printed on an invoice. */
export const invoiceDetailsSchema = obj({
  reference: f.textOptional(120, 'Reference'),
  otherReferences: f.textOptional(120, 'Other references'),
  buyerOrderNo: f.textOptional(80, 'Buyer’s order no.'),
  buyerOrderDate: f.textOptional(20, 'Date'),
  dispatchDocNo: f.textOptional(80, 'Dispatch doc no.'),
  deliveryNoteDate: f.textOptional(20, 'Delivery note date'),
  dispatchedThrough: f.textOptional(120, 'Dispatched through'),
  destination: f.textOptional(120, 'Destination'),
  termsOfDelivery: f.textOptional(300, 'Terms of delivery'),
});

export const invoiceCreateSchema = obj({
  billToCompany: f.textOptional(120, 'Company name'),
  details: invoiceDetailsSchema.optional(),
  pricing: invoicePricingInputSchema.optional(),
  termsAndConditions: f.textOptional(30000, 'Terms and Conditions'),
});

/** An invoice with no proposal: who it is for, a title, and the priced lines. `client` optionally links an existing client. */
export const directInvoiceSchema = obj({
  client: z.string().optional().nullable(),
  billTo: obj({
    name: f.orgNameRequired,
    company: f.textOptional(120, 'Company name'),
    phone: f.phoneOptional,
    email: f.emailOptional,
    address: f.textOptional(400, 'Address'),
    gstNumber: f.gstinOptional,
  }),
  title: f.textOptional(160, 'Title'),
  details: invoiceDetailsSchema.optional(),
  pricing: invoicePricingInputSchema,
  termsAndConditions: f.textOptional(30000, 'Terms and Conditions'),
});

/** A receipt with no proposal: who paid, optional title, and the payment details. */
export const directReceiptSchema = obj({
  client: z.string().optional().nullable(),
  billTo: obj({
    name: f.orgNameRequired,
    phone: f.phoneOptional,
    email: f.emailOptional,
    address: f.textOptional(400, 'Address'),
  }),
  title: f.textOptional(160, 'Title'),
  amount: f.num({ min: 0.01, max: 1e10, label: 'Amount' }),
  mode: z.enum(PAYMENT_MODES, 'Choose how the payment was made'),
  reference: f.textOptional(80, 'Reference'),
  note: f.textOptional(300, 'Note'),
  receivedOn: z.string().optional(),
});
