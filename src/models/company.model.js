import mongoose from 'mongoose';
import { COMPANY_STATUS, DEFAULT_AGENT_ROLES, DEFAULT_EXPENSE_REASONS, DEFAULT_PRODUCT_UNITS, DEFAULT_STEP_PRIORITY, DEFAULT_SUBSIDY_STEPS, STEP_PRIORITIES } from '../constants/index.js';
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

/** A step of the company's loan or subsidy process: copied onto each client's loan / subsidy when it is opened. */
const loanStepSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
    description: text(400),
  },
  subSchemaOptions,
);

/** Company-wide AMC schedule: copied onto each installation when it is completed. */
const amcTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'AMC name is required'], trim: true, maxlength: 80 },
    daysAfterInstallation: { type: Number, default: null, min: 1, max: 3650 },
    kind: { type: String, enum: ['mandatory', 'optional'], default: 'mandatory' },
    price: { type: Number, default: 0, min: 0 },
    description: text(30000, { trim: false }),
    criteria: { type: [{ type: String, trim: true, maxlength: 200 }], default: () => [], validate: [(v) => v.length <= 40, 'Up to 40 criteria per AMC'] },
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
    // AMC visits scheduled after installation completes (days counted from completion date)
    amcTemplates: { type: [amcTemplateSchema], default: () => [] },
    // loan process template: copied onto a client's loan when the client is marked as buying with a loan
    loanSteps: { type: [loanStepSchema], default: () => [] },
    // subsidy process template: copied onto a proposal's subsidy file when the proposal is marked as having a subsidy
    subsidySteps: { type: [loanStepSchema], default: () => DEFAULT_SUBSIDY_STEPS.map((s) => ({ ...s })) },
    // reasons offered when recording a project expense (Company.expenseReasons)
    expenseReasons: { type: [{ type: String, trim: true, maxlength: 300 }], default: () => [...DEFAULT_EXPENSE_REASONS] },

    // pricing used by the designer
    currency: text(8, { default: 'INR' }),
    tariff: { type: Number, default: 8, min: 0 },
    otherCostPerKw: { type: Number, default: 18000, min: 0 },

    // “per piece”, “per nos”, … — offered when adding catalog products (general categories)
    productUnits: { type: [{ type: String, trim: true, maxlength: 20, set: capFirst }], default: () => [...DEFAULT_PRODUCT_UNITS] },
    agentRoles: { type: [{ type: String, trim: true, maxlength: 40 }], default: () => [...DEFAULT_AGENT_ROLES] },
    // the company's own fields on its lead form, after the fixed Name / Phone / Address
    // (checked by leads-integration/utils/leadForm.js; managed under Manage Masters → Lead form)
    leadForm: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, required: true, trim: true, maxlength: 40 },
            label: { type: String, required: true, trim: true, maxlength: 60 },
            type: { type: String, required: true, enum: ['text', 'textarea', 'number', 'phone', 'email', 'select', 'multiselect', 'date', 'yesno'] },
            required: { type: Boolean, default: false },
            help: text(200),
            options: { type: [{ type: String, trim: true, maxlength: 60 }], default: () => [] },
          },
          { _id: false },
        ),
      ],
      default: () => [],
    },
    parentCategoriesSeeded: { type: Boolean, default: false }, // the default parent categories were created (see parentCategory.migration.js)
  },
  schemaOptions,
);

export const Company = mongoose.model('Company', companySchema);
