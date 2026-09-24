// All API routes, mounted under /api.
import { Router } from 'express';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { agentOnly, authenticate, companyOnly, superAdminOnly } from '../middlewares/auth.middleware.js';
import adminRoutes from './admin.routes.js';
import agentRoutes from './agent.routes.js';
import authRoutes from './auth.routes.js';
import { catalogRoutes, categoryRoutes, productRoutes } from './catalog.routes.js';
import clientRoutes from './client.routes.js';
import companyRoutes from './company.routes.js';
import designRoutes from './design.routes.js';
import { myProjectRoutes, projectRoutes } from './project.routes.js';
import fileRoutes from './file.routes.js';
import notificationRoutes from './notification.routes.js';
import ticketRoutes from './ticket.routes.js';
import packageRoutes from './package.routes.js';
import { solarRoutes, staticMapRoutes } from './google.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', superAdminOnly, adminRoutes);

// company workspace (tenant-scoped)
router.use('/company', companyOnly, companyRoutes);
router.use('/clients', companyOnly, clientRoutes);
router.use('/categories', companyOnly, categoryRoutes);
router.use('/products', companyOnly, productRoutes);
router.use('/packages', companyOnly, packageRoutes);
router.use('/catalog', companyOnly, catalogRoutes);

router.use('/designs', companyOnly, designRoutes);
router.use('/agents', companyOnly, agentRoutes);
router.use('/projects', companyOnly, projectRoutes);
// Google Solar / Static Maps calls cost money: limit them per user (and per address for the token-only image route)
router.use('/solar', companyOnly, rateLimit({ name: 'solar', windowMs: 10 * 60 * 1000, max: 40 }), solarRoutes);
router.use('/staticmap', rateLimit({ name: 'staticmap', windowMs: 10 * 60 * 1000, max: 300, by: 'ip' }), staticMapRoutes); // authenticates itself (header, or a short-lived map token for images)

// the signed-in user's own inbox (company owner or agent)
router.use('/notifications', authenticate, notificationRoutes);

// signed links for protected uploads (any signed-in user; access is decided per file in the service)
router.use('/files', authenticate, fileRoutes);

// support tickets: company owner <-> platform admin (access rules live in the service)
router.use('/tickets', authenticate, rateLimit({ name: 'tickets', windowMs: 10 * 60 * 1000, max: 120 }), ticketRoutes);

// agent workspace: the steps assigned to the signed-in agent
router.use('/my/projects', agentOnly, myProjectRoutes);

export default router;
