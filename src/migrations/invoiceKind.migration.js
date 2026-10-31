import { Invoice, Project } from '../models/index.js';

// Invoices for parts replaced on an AMC visit used to look like any other invoice on the proposal. They now carry
// kind "amc_parts" so the proposal's invoice, the billing overview and the dashboard ignore them. The visit knows its
// invoice (`partsInvoice`), so every one already issued can be found and marked. Invoices with no kind count as sales.
export async function markAmcPartsInvoices() {
  const [row] = await Project.aggregate([
    { $unwind: '$amcVisits' },
    { $match: { 'amcVisits.partsInvoice': { $ne: null } } },
    { $group: { _id: null, ids: { $addToSet: '$amcVisits.partsInvoice' } } },
  ]);
  if (!row?.ids?.length) return;
  const r = await Invoice.collection.updateMany({ _id: { $in: row.ids }, kind: { $ne: 'amc_parts' } }, { $set: { kind: 'amc_parts' } });
  if (r.modifiedCount) console.log(`AMC parts invoices marked: ${r.modifiedCount}`);
}
