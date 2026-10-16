import { Router } from 'express';
import { permissionOnly } from '../middlewares/auth.middleware.js';
import { uploadDesignVersionPdf } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as designs from '../controllers/design.controller.js';

const router = Router();
const view = permissionOnly('proposals', 'view');
const create = permissionOnly('proposals', 'create');
const update = permissionOnly('proposals', 'update');
const share = permissionOnly('proposals', 'share');
const changeStatus = permissionOnly('proposals', 'change_status');
const del = permissionOnly('proposals', 'delete');

router.get('/', view, designs.list);
router.post('/', create, validate(S.designCreateSchema), designs.create);
router.get('/:id/lifecycle', view, designs.lifecycle);
router.get('/:id/versions', view, designs.listVersions);
router.post('/:id/versions', update, uploadDesignVersionPdf, designs.createVersion); // archiving a PDF happens while editing
router.post('/:id/versions/:versionId/restore', update, designs.restoreVersion);
router.get('/:id', view, designs.get);
router.put('/:id', update, designs.update);
router.post('/:id/send-for-review', changeStatus, validate(S.designSendForReviewSchema), designs.sendForReview);
router.post('/:id/share', share, designs.share); // the public link's token (created on first use)
router.delete('/:id/share', share, designs.unshare); // switch the public link off — not a delete of the design itself
router.delete('/:id', del, designs.remove);
router.post('/:id/duplicate', create, designs.duplicate);

export default router;
