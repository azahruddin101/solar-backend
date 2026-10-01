import { Router } from 'express';
import { permissionOnly } from '../middlewares/auth.middleware.js';
import { uploadInvoicePdf } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { billingService as svc } from '../services/billing.service.js';
import { wrap } from '../utils/wrap.js';

const router = Router();
const view = permissionOnly('billing', 'view');
const create = permissionOnly('billing', 'create');
const del = permissionOnly('billing', 'delete');

router.get('/overview', view, wrap((req) => svc.overview(req.company)));
router.get('/payments', view, wrap((req) => svc.listPayments(req.company, { page: req.query.page, limit: req.query.limit })));
router.get('/invoices', view, wrap((req) => svc.listInvoices(req.company, { page: req.query.page, limit: req.query.limit })));
router.get('/invoices/next-number', view, wrap((req) => svc.nextInvoiceNumber(req.company)));
router.post('/invoices', create, validate(S.directInvoiceSchema), wrap((req) => svc.createDirectInvoice(req.company, req.user, req.body), 201));
router.get('/designs/:id', view, wrap((req) => svc.get(req.company, req.params.id)));
router.post('/designs/:id/payments', create, validate(S.paymentSchema), wrap((req) => svc.addPayment(req.company, req.user, req.params.id, req.body), 201));
router.post('/designs/:id/invoice', create, validate(S.invoiceCreateSchema), wrap((req) => svc.createInvoice(req.company, req.user, req.params.id, req.body), 201));
router.post('/invoices/:id/pdf', create, uploadInvoicePdf, wrap((req) => svc.attachInvoicePdf(req.company, req.params.id, req.file?.filename), 201));
router.delete('/payments/:id', del, wrap((req) => svc.removePayment(req.company, req.params.id)));

export default router;
