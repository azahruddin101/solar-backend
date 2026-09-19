import { Router } from 'express';
import * as admin from '../controllers/admin.controller.js';

const router = Router();

router.get('/stats', admin.stats);
router.get('/companies', admin.listCompanies);
router.post('/companies', admin.createCompany);
router.patch('/companies/:id', admin.updateCompany);
router.delete('/companies/:id', admin.deleteCompany);
router.post('/companies/:id/password', admin.resetPassword);
router.post('/companies/:id/impersonate', admin.impersonate);

export default router;
