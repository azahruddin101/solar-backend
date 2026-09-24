// Upload handling. multer spools the request to a temporary file (size-limited, so nothing large sits in memory), then
// the file is streamed to the storage service (S3 or local disk) under a generated name: <companyId>-<kind>-<random>.<ext>,
// and the temporary file is removed.
// Controllers only see `file.filename`, exactly as before; the DB keeps `/uploads/<filename>`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { ASSET_KINDS, IMAGE_TYPES, TICKET_FILE_TYPES } from '../constants/index.js';
import { deleteFile, putFile } from '../services/storage.service.js';
import { rateLimit } from './rateLimit.middleware.js';
import { HttpError, badRequest } from '../utils/HttpError.js';

const TMP_DIR = path.join(os.tmpdir(), 'solar-uploads');
fs.mkdirSync(TMP_DIR, { recursive: true });

/** What a file really is, from its first bytes (the declared type and file name are chosen by the sender). */
async function sniffType(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(16), 0, 16, 0);
    const b = buffer.subarray(0, bytesRead);
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    return null;
  } finally {
    await fh.close();
  }
}

const IMAGES = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGES_AND_PDF = [...IMAGES, 'application/pdf'];

const rand = (bytes) => crypto.randomBytes(bytes).toString('hex');
const imageFilter = (req, file, cb) => (IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(badRequest('Upload a PNG, JPG or WebP image')));

/** Run a multer parser, then store each file under `nameFor(req, file)`. On failure nothing is left behind. */
const uploadLimit = rateLimit({ name: 'upload', windowMs: 10 * 60 * 1000, max: 60 });

// at most a few uploads per person at once (each one occupies a connection and temporary disk space)
const MAX_IN_FLIGHT_PER_USER = 3;
const inFlight = new Map();

function withStorage(parse, nameFor, allowed = IMAGES) {
  return (req, res, next) => uploadLimit(req, res, (limited) => {
    if (limited) return next(limited); // over the limit: refuse before reading the request body
    const who = req.user ? String(req.user.id) : req.ip;
    if ((inFlight.get(who) || 0) >= MAX_IN_FLIGHT_PER_USER) return next(new HttpError(429, 'Too many uploads at once. Wait for the others to finish.', 'RATE_LIMITED'));
    inFlight.set(who, (inFlight.get(who) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inFlight.get(who) || 1) - 1;
      if (n <= 0) inFlight.delete(who); else inFlight.set(who, n);
    };
    res.once('close', release); // also covers a client that disconnects mid-upload

    parse(req, res, async (err) => {
      if (err) return next(err);
      const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : [];
      const stored = [];
      try {
        for (const file of files) {
          const real = await sniffType(file.path);
          if (!real || !allowed.includes(real)) throw badRequest(allowed === IMAGES ? 'That file is not a valid PNG, JPG or WebP image' : 'That file is not a valid PNG, JPG, WebP image or PDF');
          file.mimetype = real; // trust the content, not the header the sender chose
          file.filename = nameFor(req, file);
          await putFile(file.filename, file.path, file.mimetype); // streamed from the temporary file
          stored.push(file.filename);
        }
        next();
      } catch (e) {
        await Promise.all(stored.map(deleteFile));
        next(e);
      } finally {
        await Promise.all(files.map((f) => fs.promises.rm(f.path, { force: true }))); // the temporary copy is never kept
      }
    });
  });
}

const storage = multer.diskStorage({ destination: TMP_DIR, filename: (req, file, cb) => cb(null, `${Date.now()}-${rand(8)}`) });
const memory = (limits, fileFilter) => multer({ storage, limits, fileFilter });

/** Branding images (logo, e-signature, QR code). */
export const uploadImage = withStorage(
  memory({ fileSize: 2 * 1024 * 1024, files: 1 }, (req, file, cb) => {
    if (!ASSET_KINDS.includes(req.params.kind)) return cb(badRequest('Unknown asset'));
    imageFilter(req, file, cb);
  }).single('file'),
  (req, file) => `${req.company.id}-${req.params.kind}-${rand(6)}.${IMAGE_TYPES[file.mimetype]}`,
);

/** Client documents (bills, ID proofs, …): PNG, JPG, WebP or PDF, up to 10 MB. */
export const uploadDocument = withStorage(
  memory({ fileSize: 10 * 1024 * 1024, files: 1 }, (req, file, cb) => (TICKET_FILE_TYPES[file.mimetype] ? cb(null, true) : cb(badRequest('Upload a PNG, JPG, WebP image or a PDF')))).single('file'),
  (req, file) => `${req.company.id}-doc-${rand(8)}.${TICKET_FILE_TYPES[file.mimetype]}`,
  IMAGES_AND_PDF,
);

/** Agent profile photo (optional). */
export const uploadAgentPhoto = withStorage(
  memory({ fileSize: 2 * 1024 * 1024, files: 1 }, imageFilter).single('file'),
  (req, file) => `${req.company.id}-agent-${req.params.id}-${rand(6)}.${IMAGE_TYPES[file.mimetype] || 'jpg'}`,
);

/** Field photo when an installation step is marked done (optional). */
export const uploadStepPhoto = withStorage(
  memory({ fileSize: 5 * 1024 * 1024, files: 1 }, imageFilter).single('file'),
  (req, file) => `${req.company.id}-step-${rand(8)}.${IMAGE_TYPES[file.mimetype] || 'jpg'}`,
);

/** Support-ticket attachments: images or PDFs, up to 5 per message. */
export const MAX_TICKET_FILES = 5;
export const uploadTicketFiles = withStorage(
  memory({ fileSize: 10 * 1024 * 1024, files: MAX_TICKET_FILES }, (req, file, cb) => {
    if (!TICKET_FILE_TYPES[file.mimetype]) return cb(badRequest('Attach a PNG, JPG, WebP image or a PDF'));
    cb(null, true);
  }).array('files', MAX_TICKET_FILES),
  (req, file) => `ticket-${rand(10)}.${TICKET_FILE_TYPES[file.mimetype]}`,
  IMAGES_AND_PDF,
);
