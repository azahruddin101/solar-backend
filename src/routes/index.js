// All API routes, mounted under /api.
import { Router } from 'express';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { agentOnly, authenticate, clientOnly, companyOnly, superAdminOnly, withAreaAccess, withPermission } from '../middlewares/auth.middleware.js';
import adminRoutes from './admin.routes.js';
import agentRoutes from './agent.routes.js';
import roleRoutes from './role.routes.js';
import leadRoutes from './leads.routes.js';
import authRoutes from './auth.routes.js';
import { catalogRoutes, categoryRoutes, parentCategoryRoutes, productRoutes } from './catalog.routes.js';
import clientRoutes from './client.routes.js';
import loanRoutes from './loan.routes.js';
import subsidyRoutes from './subsidy.routes.js';
import expenseRoutes from './expense.routes.js';
import companyRoutes from './company.routes.js';
import designRoutes from './design.routes.js';
import { myProjectRoutes, projectRoutes } from './project.routes.js';
import fileRoutes from './file.routes.js';
import notificationRoutes from './notification.routes.js';
import ticketRoutes from './ticket.routes.js';
import clientTicketRoutes from './clientTicket.routes.js';
import packageRoutes from './package.routes.js';
import publicRoutes from './public.routes.js';
import portalRoutes from './portal.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import billingRoutes from './billing.routes.js';
import { stockRoutes, supplierRoutes } from './stock.routes.js';
import installationChargeRoutes from './installationCharge.routes.js';
import { solarRoutes, staticMapRoutes } from './google.routes.js';
import { staffCounts } from '../services/dashboard.service.js';
import { wrap } from '../utils/wrap.js';

const router = Router();

router.use('/auth', authRoutes);
// a proposal opened from its share link or QR code — no sign-in, tight rate limit per IP
router.use('/public', rateLimit({ name: 'public', windowMs: 10 * 60 * 1000, max: 400, by: 'ip' }), publicRoutes);
router.use('/admin', superAdminOnly, adminRoutes);
// company workspace (tenant-scoped). Each area's own route file checks the exact CRUD action
// (view/create/update/delete) a route needs; these mounts are just the outer "may they even try" gate —
// anyone with at least one action granted in the area(s) listed gets through to it.
// (routes/company.routes.js is owner-only as a whole: company settings, masters and lead integrations)
router.use('/company', authenticate, companyRoutes);
router.use('/clients', withAreaAccess('clients'), clientRoutes);
router.use('/expenses', withAreaAccess('expenses'), expenseRoutes); // what was spent on each proposal's project
router.use('/loans', withAreaAccess('loans'), loanRoutes); // clients buying with a loan, and the company's loan step template
router.use('/subsidies', withAreaAccess('subsidies'), subsidyRoutes); // proposals with a government subsidy, and the company's subsidy step template
router.use('/categories', withAreaAccess('proposals', 'inventory'), categoryRoutes); // read for the designer; writes need 'inventory' (see catalog.routes.js)
router.use('/parent-categories', withAreaAccess('inventory'), parentCategoryRoutes);
router.use('/products', withAreaAccess('proposals', 'inventory', 'finances', 'tasks'), productRoutes); // read for the designer, invoices and installations; writes need 'inventory'
router.use('/packages', withAreaAccess('proposals', 'inventory'), packageRoutes); // list/get are read by the designer too; writes need 'inventory'
router.use('/billing', withAreaAccess('finances'), billingRoutes);
router.use('/stock', withAreaAccess('inventory', 'finances', 'tasks'), stockRoutes); // batches and serial units; writes need 'inventory'
router.use('/suppliers', withAreaAccess('inventory', 'finances', 'tasks'), supplierRoutes);
router.use('/dashboard', companyOnly, dashboardRoutes);
router.use('/installation-charges', withAreaAccess('proposals', 'inventory'), installationChargeRoutes);
router.use('/catalog', withAreaAccess('proposals', 'inventory'), catalogRoutes); // the designer's own read-only aggregated catalog, also used by the catalog management page

router.use('/designs', withAreaAccess('proposals'), designRoutes);
router.use('/leads', withAreaAccess('leads'), leadRoutes); // each route checks its Leads permission; staff see their own leads unless they may view all
router.use('/agents', companyOnly, agentRoutes); // only the owner manages staff accounts and their permissions
router.use('/roles', companyOnly, roleRoutes); // …and the roles (named permission sets) given to them
router.use('/projects', withAreaAccess('tasks'), projectRoutes);
// Google Solar / Static Maps calls cost money: limit them per user (and per address for the token-only image route)
router.use('/solar', withPermission('proposals', 'view'), rateLimit({ name: 'solar', windowMs: 10 * 60 * 1000, max: 40 }), solarRoutes);
router.use('/staticmap', rateLimit({ name: 'staticmap', windowMs: 10 * 60 * 1000, max: 300, by: 'ip' }), staticMapRoutes); // authenticates itself (header, or a short-lived map token for images)

// the signed-in user's own inbox (company owner or agent)
router.use('/notifications', authenticate, notificationRoutes);

// signed links for protected uploads (any signed-in user; access is decided per file in the service)
router.use('/files', authenticate, fileRoutes);

// support tickets: company owner <-> platform admin (access rules live in the service)
router.use('/tickets', authenticate, rateLimit({ name: 'tickets', windowMs: 10 * 60 * 1000, max: 120 }), ticketRoutes);

// client support: a company <-> its clients (the client side is /portal/tickets). Separate from the tickets above.
router.use('/client-tickets', withAreaAccess('helpdesk'), rateLimit({ name: 'client-tickets', windowMs: 10 * 60 * 1000, max: 240 }), clientTicketRoutes);

// agent workspace: the steps assigned to the signed-in agent
router.use('/my/projects', agentOnly, myProjectRoutes);
router.get('/my/counts', agentOnly, wrap((req) => staffCounts(req.user, req.company))); // the staff sidebar's numbers, for the areas they may view

// client portal: a client's proposals and responses on open proposals
router.use('/portal', clientOnly, portalRoutes);

export default router;
