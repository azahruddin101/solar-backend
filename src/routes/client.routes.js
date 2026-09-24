import { Router } from 'express';
import * as clients from '../controllers/client.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadDocument } from '../middlewares/upload.middleware.js';

const router = Router();

router.get('/', clients.list);
router.get('/:id', clients.get);
router.post('/upload-document', uploadDocument, clients.uploadDoc);
router.post('/', validate(S.clientSchema), clients.create);
router.put('/:id', validate(S.clientUpdateSchema), clients.update);
router.delete('/:id', clients.remove);

export default router;
