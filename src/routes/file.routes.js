import { Router } from 'express';
import * as files from '../controllers/file.controller.js';

const router = Router();

router.get('/link', files.link);
router.get('/share-link', files.shareLink);

export default router;
