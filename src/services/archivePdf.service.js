// Archiving the PDF of an issued document (invoice, receipt, e-way bill, bill) on its row — once.
import { conflict, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { deleteFile } from './storage.service.js';

/**
 * Stores the PDF of an issued document — once. The archived PDF is the document the client was given, so it is never
 * replaced or deleted afterwards (a second upload is refused and its file removed). The check and the write are one
 * atomic update, so two uploads at the same moment can't both win.
 */
export async function archivePdfOnce(Model, what, company, id, pdfName) {
  let filter;
  try {
    filter = { _id: objectId(id, what), company: company._id };
  } catch (e) {
    await deleteFile(pdfName).catch(() => {});
    throw e;
  }
  const stored = await Model.findOneAndUpdate(
    { ...filter, $or: [{ pdfName: '' }, { pdfName: null }, { pdfName: { $exists: false } }] },
    { $set: { pdfName } },
    { new: true },
  );
  if (stored) return { ok: true, pdfName };
  await deleteFile(pdfName).catch(() => {});
  if (!(await Model.exists(filter))) throw notFound(what);
  throw conflict(`This ${what.toLowerCase()} already has its PDF archived. Issued documents can't be replaced.`);
}
