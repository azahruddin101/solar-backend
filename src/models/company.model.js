import mongoose from 'mongoose';
import { COMPANY_STATUS, PLANS } from '../constants/index.js';
import { schemaOptions, text } from './schemaOptions.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: text(200),
    phone: text(40),
    address: text(400),
    website: text(200),
    taxId: text(60), // GSTIN / VAT no.

    // controlled by the super admin
    status: { type: String, enum: COMPANY_STATUS, default: 'active' },
    plan: { type: String, enum: PLANS, default: 'starter' },
    limits: {
      maxClients: { type: Number, default: 0, min: 0 }, // 0 = unlimited
      maxDesigns: { type: Number, default: 0, min: 0 },
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

    // pricing used by the designer
    currency: text(8, { default: 'INR' }),
    tariff: { type: Number, default: 8, min: 0 },
    otherCostPerKw: { type: Number, default: 18000, min: 0 },
  },
  schemaOptions,
);

export const Company = mongoose.model('Company', companySchema);
