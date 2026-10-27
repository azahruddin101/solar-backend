// Where uploaded files live. With S3_BUCKET set they go to S3 (the bucket stays private; the API streams
// files back at /uploads/<name>). Without it they use the local uploads folder, so development needs no AWS.
// Callers only deal in the file's name; the DB keeps storing `/uploads/<name>` as before.
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

export const usingS3 = () => Boolean(env.s3.bucket);

let client;
const s3 = () => (client ||= new S3Client({
  region: env.s3.region,
  ...(env.s3.endpoint && { endpoint: env.s3.endpoint }),
  ...(env.s3.forcePathStyle && { forcePathStyle: true }),
}));

const keyOf = (name) => `${env.s3.prefix}${path.basename(name)}`;
const localPath = (name) => path.join(env.uploadDir, path.basename(name));
const missing = (e) => e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404 || e?.code === 'ENOENT';

/** `body` is a Buffer, or the path of a file on disk (streamed, so a large upload is never held in memory). */
export async function putFile(name, body, contentType = 'application/octet-stream') {
  const fromDisk = typeof body === 'string';
  if (usingS3()) {
    const source = fromDisk ? { Body: createReadStream(body), ContentLength: (await fs.stat(body)).size } : { Body: body };
    await s3().send(new PutObjectCommand({ Bucket: env.s3.bucket, Key: keyOf(name), ContentType: contentType, ...source }));
    return;
  }
  await fs.mkdir(env.uploadDir, { recursive: true });
  if (fromDisk) await fs.copyFile(body, localPath(name));
  else await fs.writeFile(localPath(name), body);
}

/** Best-effort delete: a missing file is fine. */
export async function deleteFile(name) {
  if (!name) return;
  try {
    if (usingS3()) await s3().send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: keyOf(name) }));
    await fs.rm(localPath(name), { force: true }); // also clears a not-yet-migrated local copy
  } catch (e) {
    console.error(`[storage] could not delete ${name}: ${e.message}`);
  }
}

/** Delete every file whose name starts with `prefix` (e.g. all of a company's uploads). */
export async function deleteByPrefix(prefix) {
  try {
    if (usingS3()) {
      let token;
      do {
        const page = await s3().send(new ListObjectsV2Command({ Bucket: env.s3.bucket, Prefix: `${env.s3.prefix}${prefix}`, ContinuationToken: token }));
        const keys = (page.Contents || []).map((o) => ({ Key: o.Key }));
        if (keys.length) await s3().send(new DeleteObjectsCommand({ Bucket: env.s3.bucket, Delete: { Objects: keys } }));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    }
    const files = await fs.readdir(env.uploadDir).catch(() => []);
    await Promise.all(files.filter((f) => f.startsWith(prefix)).map((f) => fs.rm(localPath(f), { force: true })));
  } catch (e) {
    console.error(`[storage] could not delete files starting ${prefix}: ${e.message}`);
  }
}

/** { stream, contentType, contentLength, etag, lastModified } or null when the file does not exist. */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/** The byte span a `Range: bytes=…` header asks for in a file of `size` bytes; null for none/several, false if it can't be met. */
function byteSpan(header, size) {
  const m = SINGLE_RANGE.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // no range, or several (served whole)
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2])); // bytes=-N: the last N bytes
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? false : { start, end };
}

/**
 * A readable stream of a stored file, or null if there is none. With `range` (the request's Range header) only that part
 * is read (`partial` with `contentRange` set), so a PDF viewer can show the first pages before the rest has arrived;
 * `unsatisfiable` when the range lies outside the file.
 */
export async function openFile(name, { range } = {}) {
  if (usingS3()) {
    const ranged = SINGLE_RANGE.test(String(range || '').trim()) && range.trim() !== 'bytes=-';
    try {
      const obj = await s3().send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: keyOf(name), ...(ranged && { Range: range.trim() }) }));
      const partial = Boolean(obj.ContentRange);
      return { stream: obj.Body, contentType: obj.ContentType, contentLength: obj.ContentLength, etag: obj.ETag, lastModified: obj.LastModified, partial, contentRange: obj.ContentRange };
    } catch (e) {
      if (e?.name === 'InvalidRange' || e?.$metadata?.httpStatusCode === 416) return { unsatisfiable: true, contentRange: 'bytes */*' };
      if (!missing(e)) throw e;
      // fall through: a file uploaded before the move to S3 may still be on disk
    }
  }
  try {
    const stat = await fs.stat(localPath(name));
    if (!stat.isFile()) return null;
    const meta = { contentType: null, etag: `"${stat.size}-${Math.floor(stat.mtimeMs)}"`, lastModified: stat.mtime };
    const span = byteSpan(range, stat.size);
    if (span === false) return { ...meta, unsatisfiable: true, contentRange: `bytes */${stat.size}` };
    if (span) {
      const { start, end } = span;
      return { ...meta, stream: createReadStream(localPath(name), { start, end }), contentLength: end - start + 1, partial: true, contentRange: `bytes ${start}-${end}/${stat.size}` };
    }
    return { ...meta, stream: createReadStream(localPath(name)), contentLength: stat.size };
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}
