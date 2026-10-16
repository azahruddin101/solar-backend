import { pdfNameForToken } from '../services/fileShare.service.js';
import { streamUpload } from '../utils/streamUpload.js';

export async function document(req, res, next) {
  try {
    const name = await pdfNameForToken(req.params.token);
    if (!(await streamUpload(name, req, res))) res.status(404).end();
  } catch (err) {
    next(err);
  }
}
