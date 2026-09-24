// Branding images live in the uploads folder (written by multer, see upload.middleware.js) and are
// served at /uploads/<file>. File names start with the owning company's id.
import path from 'node:path';
import { ASSET_KINDS } from '../constants/index.js';
import { badRequest } from '../utils/HttpError.js';
import { deleteByPrefix, deleteFile } from './storage.service.js';

const assertKind = (kind) => {
  if (!ASSET_KINDS.includes(kind)) throw badRequest('Unknown asset');
};

export const publicPath = (fileName) => `/uploads/${fileName}`;

async function removeFile(company, kind) {
  // basename + id prefix: only ever delete this company's own files inside the uploads folder
  const name = path.basename(company[kind] || '');
  if (name.startsWith(`${company.id}-`)) await deleteFile(name);
}

/** `file` is the multer file that was just stored on disk. */
export async function saveAsset(company, kind, file) {
  assertKind(kind);
  if (!file) throw badRequest('Choose an image to upload');
  await removeFile(company, kind); // replace the previous image
  company[kind] = publicPath(file.filename);
  await company.save();
  return company;
}

export async function deleteAsset(company, kind) {
  assertKind(kind);
  await removeFile(company, kind);
  company[kind] = '';
  await company.save();
  return company;
}

export async function deleteCompanyAssets(companyId) {
  await deleteByPrefix(`${companyId}-`);
}
