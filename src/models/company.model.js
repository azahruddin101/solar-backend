import mongoose from 'mongoose';
import { COMPANY_STATUS, DEFAULT_AGENT_ROLES, DEFAULT_PRODUCT_UNITS, DEFAULT_STEP_PRIORITY, STEP_PRIORITIES } from '../constants/index.js';
import { capFirst } from '../utils/text.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

const installationStepSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
    description: text(400),
    role: text(40), // agent role that should do this step (from the company's agentRoles list)
    priority: { type: String, enum: STEP_PRIORITIES, default: DEFAULT_STEP_PRIORITY },
  },
  subSchemaOptions,
);

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: text(200),
    phone: text(40),
    address: text(400),
    website: text(200),
    taxId: text(60), // GSTIN
    pan: text(10),

    // controlled by the super admin
    status: { type: String, enum: COMPANY_STATUS, default: 'active' },
    plan: { type: String, default: 'starter' }, // legacy label; use planRef
    planRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null, index: true },
    limits: {
      maxClients: { type: Number, default: 25, min: 1 }, // set from the company's plan; nothing is unlimited
      maxDesigns: { type: Number, default: 50, min: 1 },
      maxConcurrentLogins: { type: Number, default: 2, min: 1 },
    },
    subscription: {
      periodStart: { type: Date, default: null },
      periodEnd: { type: Date, default: null },
      status: {
        type: String,
        enum: ['none', 'active', 'cancelled'],
        default: 'none',
      },
      billingCycle: { type: String, default: 'monthly' },
      cancelAtPeriodEnd: { type: Boolean, default: false },
    },
    features: {
      pdfBranding: { type: Boolean, default: true }, // logo / colours / signature / QR on the PDF
      excelImport: { type: Boolean, default: true },
    },
    notes: text(1000), // super admin's private notes

    // branding
    theme: {
      primary: { type: String, match: [HEX, 'Theme colours must be hex values like #1d4ed8'], default: '#1d4ed8' },
      accent: { type: String, match: [HEX, 'Theme colours must be hex values like #f59e0b'], default: '#f59e0b' },
    },
    logo: text(300),
    signature: text(300),
    qr: text(300),
    signatoryName: text(120),
    signatoryTitle: text(120),
    qrLabel: text(80, { default: 'Scan to pay / contact us' }),
    tagline: text(60, { default: 'Clean energy for a brighter tomorrow' }), // script lettering on the PDF cover
    pdfTerms: text(30000, { trim: false }), // sanitised HTML from the rich text editor (utils/richText.js)

    // invoice numbers: `${prefix}${next padded to width}` — see services/invoiceNumber.service.js.
    // `next` is reserved with an atomic $inc at generation time; null = never set, continue the legacy Counter.
    invoiceNumbering: {
      prefix: text(20, { default: 'INV-' }),
      width: { type: Number, default: 4, min: 1, max: 10 },
      next: { type: Number, default: null, min: 1 },
    },

    // installation workflow template: copied into a project when an installation starts
    installationSteps: [installationStepSchema],

    // pricing used by the designer
    currency: text(8, { default: 'INR' }),
    tariff: { type: Number, default: 8, min: 0 },
    otherCostPerKw: { type: Number, default: 18000, min: 0 },

    // “per piece”, “per nos”, … — offered when adding catalog products (general categories)
    productUnits: { type: [{ type: String, trim: true, maxlength: 20, set: capFirst }], default: () => [...DEFAULT_PRODUCT_UNITS] },
    agentRoles: { type: [{ type: String, trim: true, maxlength: 40 }], default: () => [...DEFAULT_AGENT_ROLES] },
    parentCategoriesSeeded: { type: Boolean, default: false }, // the default parent categories were created (see parentCategory.migration.js)
  },
  schemaOptions,
);

export const Company = mongoose.model('Company', companySchema);
