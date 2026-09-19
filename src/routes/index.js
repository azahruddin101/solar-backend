// All API routes, mounted under /api.
import { Router } from 'express';
import { companyOnly, superAdminOnly } from '../middlewares/auth.middleware.js';
import adminRoutes from './admin.routes.js';
import authRoutes from './auth.routes.js';
import { catalogRoutes, panelRoutes, pillarRoutes } from './catalog.routes.js';
import clientRoutes from './client.routes.js';
import companyRoutes from './company.routes.js';
import designRoutes from './design.routes.js';
import { solarRoutes, staticMapRoutes } from './google.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', superAdminOnly, adminRoutes);

// company workspace (tenant-scoped)
router.use('/company', companyOnly, companyRoutes);
router.use('/clients', companyOnly, clientRoutes);
router.use('/panels', companyOnly, panelRoutes);
router.use('/pillars', companyOnly, pillarRoutes);
router.use('/catalog', companyOnly, catalogRoutes);
router.use('/designs', companyOnly, designRoutes);
router.use('/solar', companyOnly, solarRoutes);
router.use('/staticmap', companyOnly, staticMapRoutes);

export default router;
