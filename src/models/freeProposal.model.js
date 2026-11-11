import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// A proposal made with the free proposal maker on the public site (/free-proposal), without signing in. It
// belongs to no company and uses none of the workspace data (clients, designs, catalog): everything in it was
// typed by the visitor. The platform admin sees these as leads, with the visitor's device and where they were.
export const FREE_PROPOSAL_STATUS = ['new', 'contacted', 'converted', 'closed'];

const freeProposalSchema = new mongoose.Schema(
  {
    refNo: { type: String, required: true, unique: true }, // FP-261111-9F2C, printed on the proposal
    token: { type: String, required: true, unique: true }, // the visitor's link back to their proposal
    // who made it (the lead): copied out of `data.company` so the list can be read and searched
    companyName: text(160),
    contactName: text(120),
    phone: text(20),
    email: text(160, { lowercase: true }),
    clientName: text(160),
    // everything the visitor typed: { company, client, system, items, pricing, terms, design } (see the service)
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    logo: { type: String, default: '' }, // their logo as a small data: image
    totals: { type: mongoose.Schema.Types.Mixed, default: null }, // worked out here from the items
    downloads: { type: Number, default: 0 },
    // the visitor's device, as their browser reported it
    device: {
      userAgent: text(400),
      browser: text(60),
      os: text(60),
      type: text(20), // mobile | tablet | desktop
      screen: text(20), // e.g. 1440x900
      language: text(20),
      platform: text(60),
    },
    // where the visitor was: their IP, their clock's time zone, and their position when they chose to share it
    location: {
      ip: text(60),
      timezone: text(60),
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracyM: { type: Number, default: null },
    },
    referrer: text(300),
    status: { type: String, enum: FREE_PROPOSAL_STATUS, default: 'new', index: true },
    adminNotes: text(2000),
  },
  { ...schemaOptions, minimize: false },
);
freeProposalSchema.index({ createdAt: -1 });

export const FreeProposal = mongoose.model('FreeProposal', freeProposalSchema);
