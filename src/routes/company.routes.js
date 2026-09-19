import { Router } from 'express';
import * as company from '../controllers/company.controller.js';
import { uploadImage } from '../middlewares/upload.middleware.js';

const router = Router();

router.get('/', company.getCompany);
router.put('/', company.updateCompany);
router.post('/assets/:kind', uploadImage, company.uploadAsset);
router.delete('/assets/:kind', company.deleteAsset);

export default router;
