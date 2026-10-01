import { Router } from 'express';
import * as clients from '../controllers/client.controller.js';
import { permissionOnly } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadDocument } from '../middlewares/upload.middleware.js';

const router = Router();
const view = permissionOnly('clients', 'view');
const create = permissionOnly('clients', 'create');
const update = permissionOnly('clients', 'update');
const del = permissionOnly('clients', 'delete');

router.get('/', view, clients.list);
router.get('/:id', view, clients.get);
router.post('/upload-document', update, uploadDocument, clients.uploadDoc);
router.post('/', create, validate(S.clientSchema), clients.create);
router.put('/:id', update, validate(S.clientUpdateSchema), clients.update);
router.delete('/:id', del, clients.remove);
router.post('/:id/login', update, clients.createLogin); // create the client's sign-in, or reset its password — part of managing the client
router.delete('/:id/login', update, clients.removeLogin);

export default router;
