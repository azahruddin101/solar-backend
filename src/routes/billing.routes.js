import { Router } from 'express';
import { permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { uploadBillPdf, uploadCreditNotePdf, uploadEwayBillPdf, uploadInvoicePdf } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { billingService as svc } from '../services/billing.service.js';
import { billService } from '../services/bill.service.js';
import { creditNoteService, returnableOf } from '../services/creditNote.service.js';
import { ewayBillService } from '../services/ewayBill.service.js';
import { wrap } from '../utils/wrap.js';

const router = Router();
const view = permissionOnly('finances', 'view');
const invoice = permissionOnly('finances', 'create_invoice');
const ewayBill = permissionOnly('finances', 'create_eway_bill');
const bill = permissionOnly('finances', 'create_bill');

// voiding is the company owner's alone: it removes a payment and reopens goods, so it is not a staff permission
const ownerOnly = requireRole(ROLES.COMPANY);

const dates = (req) => ({ from: req.query.from, to: req.query.to });

router.get('/overview', view, wrap((req) => svc.overview(req.company, dates(req))));
router.get('/invoices', view, wrap((req) => svc.listInvoices(req.company, { page: req.query.page, limit: req.query.limit, ...dates(req) })));
router.get('/invoices/next-number', invoice, wrap((req) => svc.nextInvoiceNumber(req.company)));
router.get('/designs/:id', view, wrap((req) => svc.get(req.company, req.params.id)));
router.get('/clients/:id', view, wrap((req) => svc.getClient(req.company, req.params.id))); // a client's sale chain with no proposal

// the sale chain: e-way bill (stock out) → bill (paid) → invoice (consolidates bills)
const party = (req) => ({ design: req.query.design, client: req.query.client });
router.get('/eway-bills', view, wrap((req) => ewayBillService.list(req.company, { page: req.query.page, limit: req.query.limit, status: req.query.status, ...dates(req) })));
router.get('/eway-bills/open', view, wrap((req) => ewayBillService.open(req.company, party(req))));
router.get('/eway-bills/:id', view, wrap((req) => ewayBillService.get(req.company, req.params.id)));
router.post('/eway-bills', ewayBill, validate(S.ewayBillCreateSchema), wrap((req) => ewayBillService.create(req.company, req.user, req.body), 201));
router.post('/eway-bills/:id/cancel', ewayBill, validate(S.ewayBillCancelSchema), wrap((req) => ewayBillService.cancel(req.company, req.params.id, req.body)));
router.post('/eway-bills/:id/pdf', ewayBill, uploadEwayBillPdf, wrap((req) => ewayBillService.attachPdf(req.company, req.params.id, req.file?.filename), 201));
router.get('/bills', view, wrap((req) => billService.list(req.company, { page: req.query.page, limit: req.query.limit, status: req.query.status, ...dates(req) })));
router.get('/bills/uninvoiced', view, wrap((req) => billService.uninvoiced(req.company, party(req))));
router.get('/bills/:id', view, wrap((req) => billService.get(req.company, req.params.id)));
router.post('/bills', bill, validate(S.billCreateSchema), wrap((req) => billService.create(req.company, req.user, req.body), 201));
router.post('/bills/:id/pdf', bill, uploadBillPdf, wrap((req) => billService.attachPdf(req.company, req.params.id, req.file?.filename), 201));
// goods back on a paid bill: a credit note, the owner's alone like voiding (it takes money off the books and puts goods back)
router.get('/bills/:id/returnable', view, wrap((req) => returnableOf(req.company, req.params.id)));
router.post('/bills/:id/credit-notes', ownerOnly, validate(S.creditNoteCreateSchema), wrap((req) => creditNoteService.create(req.company, req.user, req.params.id, req.body), 201));
router.get('/credit-notes', view, wrap((req) => creditNoteService.list(req.company, { page: req.query.page, limit: req.query.limit, ...dates(req) })));
router.get('/credit-notes/:id', view, wrap((req) => creditNoteService.get(req.company, req.params.id)));
router.post('/credit-notes/:id/pdf', ownerOnly, uploadCreditNotePdf, wrap((req) => creditNoteService.attachPdf(req.company, req.params.id, req.file?.filename), 201));
router.post('/bills/:id/void', ownerOnly, validate(S.voidSchema), wrap((req) => billService.void(req.company, req.user, req.params.id, req.body)));
router.post('/invoices/:id/void', ownerOnly, validate(S.voidSchema), wrap((req) => svc.voidInvoice(req.company, req.user, req.params.id, req.body)));
router.post('/invoices/from-bills', invoice, validate(S.invoiceFromBillsSchema), wrap((req) => svc.createInvoiceFromBills(req.company, req.user, req.body), 201));
router.post('/invoices/:id/pdf', invoice, uploadInvoicePdf, wrap((req) => svc.attachInvoicePdf(req.company, req.params.id, req.file?.filename), 201));

export default router;
