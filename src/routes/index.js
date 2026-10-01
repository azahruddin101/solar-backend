// All API routes, mounted under /api.
import { Router } from 'express';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { agentOnly, authenticate, clientOnly, companyOnly, superAdminOnly, withAreaAccess, withPermission } from '../middlewares/auth.middleware.js';
import adminRoutes from './admin.routes.js';
import agentRoutes from './agent.routes.js';
import authRoutes from './auth.routes.js';
import { catalogRoutes, categoryRoutes, parentCategoryRoutes, productRoutes } from './catalog.routes.js';
import clientRoutes from './client.routes.js';
import companyRoutes from './company.routes.js';
import designRoutes from './design.routes.js';
import { myProjectRoutes, projectRoutes } from './project.routes.js';
import fileRoutes from './file.routes.js';
import notificationRoutes from './notification.routes.js';
import ticketRoutes from './ticket.routes.js';
import packageRoutes from './package.routes.js';
import publicRoutes from './public.routes.js';
import portalRoutes from './portal.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import billingRoutes from './billing.routes.js';
import installationChargeRoutes from './installationCharge.routes.js';
import { solarRoutes, staticMapRoutes } from './google.routes.js';

const router = Router();

router.use('/auth', authRoutes);
// a proposal opened from its share link or QR code — no sign-in, tight rate limit per IP
router.use('/public', rateLimit({ name: 'public', windowMs: 10 * 60 * 1000, max: 400, by: 'ip' }), publicRoutes);
router.use('/admin', superAdminOnly, adminRoutes);

// company workspace (tenant-scoped). Each area's own route file checks the exact CRUD action
// (view/create/update/delete) a route needs; these mounts are just the outer "may they even try" gate —
// anyone with at least one action granted in the area(s) listed gets through to it.
// (routes/company.routes.js gates each of its own routes individually — /catalog-settings accepts
// 'catalog:update', everything else there stays owner-only — so this mount only needs `authenticate`)
router.use('/company', authenticate, companyRoutes);
router.use('/clients', withAreaAccess('clients'), clientRoutes);
router.use('/categories', withAreaAccess('designs', 'catalog'), categoryRoutes); // read for the designer; writes need 'catalog' (see catalog.routes.js)
router.use('/parent-categories', withAreaAccess('catalog'), parentCategoryRoutes);
router.use('/products', withAreaAccess('designs', 'catalog'), productRoutes); // same: read for the designer, writes need 'catalog'
router.use('/packages', withAreaAccess('designs', 'catalog'), packageRoutes); // list/get are read by the designer too; writes need 'catalog'
router.use('/billing', withAreaAccess('billing'), billingRoutes);
router.use('/dashboard', companyOnly, dashboardRoutes);
router.use('/installation-charges', withAreaAccess('designs', 'catalog'), installationChargeRoutes);
router.use('/catalog', withAreaAccess('designs', 'catalog'), catalogRoutes); // the designer's own read-only aggregated catalog, also used by the catalog management page

router.use('/designs', withAreaAccess('designs'), designRoutes);
router.use('/agents', companyOnly, agentRoutes); // only the owner manages staff accounts and their permissions
router.use('/projects', withAreaAccess('installations'), projectRoutes);
// Google Solar / Static Maps calls cost money: limit them per user (and per address for the token-only image route)
router.use('/solar', withPermission('designs', 'view'), rateLimit({ name: 'solar', windowMs: 10 * 60 * 1000, max: 40 }), solarRoutes);
router.use('/staticmap', rateLimit({ name: 'staticmap', windowMs: 10 * 60 * 1000, max: 300, by: 'ip' }), staticMapRoutes); // authenticates itself (header, or a short-lived map token for images)

// the signed-in user's own inbox (company owner or agent)
router.use('/notifications', authenticate, notificationRoutes);

// signed links for protected uploads (any signed-in user; access is decided per file in the service)
router.use('/files', authenticate, fileRoutes);

// support tickets: company owner <-> platform admin (access rules live in the service)
router.use('/tickets', authenticate, rateLimit({ name: 'tickets', windowMs: 10 * 60 * 1000, max: 120 }), ticketRoutes);

// agent workspace: the steps assigned to the signed-in agent
router.use('/my/projects', agentOnly, myProjectRoutes);

// client portal: a client's proposals and responses on open proposals
router.use('/portal', clientOnly, portalRoutes);

export default router;
