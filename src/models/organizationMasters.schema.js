import mongoose from 'mongoose';
import { DEFAULT_AGENT_ROLES, DEFAULT_EXPENSE_REASONS, DEFAULT_PRODUCT_UNITS, DEFAULT_STEP_PRIORITY, DEFAULT_SUBSIDY_STEPS, STEP_PRIORITIES } from '../constants/index.js';
import { capFirst } from '../utils/text.js';
import { subSchemaOptions, text } from './schemaOptions.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

export const installationStepSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
    description: text(400),
    role: text(40),
    priority: { type: String, enum: STEP_PRIORITIES, default: DEFAULT_STEP_PRIORITY },
  },
  subSchemaOptions,
);

export const loanStepSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
    description: text(400),
  },
  subSchemaOptions,
);

export const amcTemplateSchema = new mongoose.Schema(
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

/** Shared master + branding fields used at organization level (all branches consume). */
export function organizationMastersFields() {
  return {
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
    // bank details for payment, printed on the proposal next to the QR code
    bankAccountName: text(120),
    bankName: text(120),
    bankAccountNumber: text(40),
    bankIfsc: text(20),
    bankBranch: text(120),
    bankAccountType: text(40),
    upiId: text(80),
    paymentQr: text(300), // a payment (UPI) QR image, printed with the bank details; not the proposal QR
    paymentQrLabel: text(80, { default: 'Scan to pay with any UPI app' }),
    tagline: text(60, { default: 'Clean energy for a brighter tomorrow' }),
    pdfTerms: text(30000, { trim: false }),
    invoiceNumbering: {
      prefix: text(20, { default: 'INV-' }),
      width: { type: Number, default: 4, min: 1, max: 10 },
      next: { type: Number, default: null, min: 1 },
    },
    installationSteps: [installationStepSchema],
    amcTemplates: { type: [amcTemplateSchema], default: () => [] },
    loanSteps: { type: [loanStepSchema], default: () => [] },
    subsidySteps: { type: [loanStepSchema], default: () => DEFAULT_SUBSIDY_STEPS.map((s) => ({ ...s })) },
    expenseReasons: { type: [{ type: String, trim: true, maxlength: 300 }], default: () => [...DEFAULT_EXPENSE_REASONS] },
    currency: text(8, { default: 'INR' }),
    // the tax's name on screens and PDFs (GST, VAT, Sales tax…) and the rate new items start with (always editable)
    taxLabel: text(20, { default: 'GST' }),
    taxRate: { type: Number, default: 18, min: 0, max: 100 },
    tariff: { type: Number, default: 8, min: 0 },
    otherCostPerKw: { type: Number, default: 18000, min: 0 },
    productUnits: { type: [{ type: String, trim: true, maxlength: 20, set: capFirst }], default: () => [...DEFAULT_PRODUCT_UNITS] },
    agentRoles: { type: [{ type: String, trim: true, maxlength: 40 }], default: () => [...DEFAULT_AGENT_ROLES] },
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
    parentCategoriesSeeded: { type: Boolean, default: false },
  };
}

/**
 * Settings every branch shares, stored on the Organization only (models/companyMasters.plugin.js applies them to every
 * branch read). Not here on purpose - they belong to each branch:
 *  - invoiceNumbering: each branch issues its own invoice series (its running number is reserved on the branch);
 *  - parentCategoriesSeeded: whether this branch's own default categories were created.
 */
export const MASTER_FIELD_KEYS = [
  'theme', 'logo', 'signature', 'qr', 'signatoryName', 'signatoryTitle', 'qrLabel', 'tagline', 'pdfTerms',
  'bankAccountName', 'bankName', 'bankAccountNumber', 'bankIfsc', 'bankBranch', 'bankAccountType', 'upiId', 'paymentQr', 'paymentQrLabel',
  'installationSteps', 'amcTemplates', 'loanSteps', 'subsidySteps', 'expenseReasons',
  'currency', 'taxLabel', 'taxRate', 'tariff', 'otherCostPerKw', 'productUnits', 'agentRoles', 'leadForm',
];
