import { Router } from 'express';
import * as projects from '../controllers/project.controller.js';
import { permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadInvoicePdf, uploadStepPhoto } from '../middlewares/upload.middleware.js';

/** Company owner: step template + every installation. */
export const projectRoutes = Router();
const view = permissionOnly('tasks', 'view');
const create = permissionOnly('tasks', 'create');
const update = permissionOnly('tasks', 'update');
const del = permissionOnly('tasks', 'delete');
const status = permissionOnly('tasks', 'change_status');
// a step update may edit, (re)assign or change the status; the service checks the permission for each part it changes
const anyStepChange = permissionOnly('tasks', 'update', 'assign', 'change_status');
// parts replaced on an AMC visit are taken from stock and invoiced to the client (the PDF is built by the browser and archived here)
const invoiceParts = permissionOnly('tasks', 'invoice_parts');

projectRoutes.get('/steps', view, projects.getSteps);
// the installation step template is a company master: only the owner changes it
projectRoutes.put('/steps', requireRole(ROLES.COMPANY), projects.updateSteps);
projectRoutes.get('/amc-templates', view, projects.getAmcTemplates);
projectRoutes.put('/amc-templates', requireRole(ROLES.COMPANY), validate(S.amcTemplatesSchema), projects.updateAmcTemplates);
projectRoutes.get('/amc-overview', view, projects.amcOverview);
projectRoutes.get('/amc-visits', view, projects.amcVisits);
projectRoutes.get('/amc-requests', view, projects.amcRequests);
projectRoutes.put('/amc-requests/:designId/:requestId/assign', permissionOnly('tasks', 'assign'), validate(S.amcRequestAssignSchema), projects.assignAmcRequest);
// who installation steps can be assigned to (the owner's staff list is owner-only; this is just names and job roles)
projectRoutes.get('/assignees', permissionOnly('tasks', 'assign'), projects.assignees);
projectRoutes.get('/', view, projects.list);
projectRoutes.post('/', create, validate(S.projectStartSchema), projects.start);
projectRoutes.get('/:id/lifecycle', view, projects.lifecycle);
projectRoutes.get('/:id', view, projects.get);
projectRoutes.delete('/:id', del, projects.remove);
projectRoutes.post('/:id/notes', anyStepChange, validate(S.noteSchema), projects.addNote);
projectRoutes.post('/:id/steps', update, validate(S.stepCreateSchema), projects.addStep);
projectRoutes.put('/:id/steps/:stepId', anyStepChange, validate(S.stepUpdateSchema), projects.updateStep);
projectRoutes.post('/:id/steps/:stepId/photo', status, uploadStepPhoto, projects.uploadStepPhoto);
projectRoutes.delete('/:id/steps/:stepId', del, projects.removeStep);
projectRoutes.put('/:id/amc/:visitId', status, validate(S.amcVisitCompleteSchema), projects.completeAmcVisit);
projectRoutes.put('/:id/amc/:visitId/assign', permissionOnly('tasks', 'assign'), validate(S.amcRequestAssignSchema), projects.assignAmcVisit);
projectRoutes.post('/:id/amc', permissionOnly('tasks', 'assign'), validate(S.amcVisitCreateSchema), projects.createAmcVisit); // the company adds an AMC visit to an installation
projectRoutes.get('/:id/amc/:visitId/invoice', invoiceParts, projects.amcPartsInvoice);
projectRoutes.post('/:id/amc/:visitId/invoice', invoiceParts, validate(S.amcPartsInvoiceSchema), projects.invoiceAmcParts);
projectRoutes.post('/:id/amc/:visitId/invoice/pdf', invoiceParts, uploadInvoicePdf, projects.attachAmcPartsInvoicePdf);

/** Agent: only the installations they hold a step in. */
export const myProjectRoutes = Router();
myProjectRoutes.get('/', projects.listMine);
myProjectRoutes.get('/amc-overview', projects.amcOverviewMine);
myProjectRoutes.get('/amc-visits', projects.amcVisitsMine);
myProjectRoutes.get('/:id/lifecycle', projects.lifecycleMine);
myProjectRoutes.get('/:id', projects.getMine);
myProjectRoutes.post('/:id/notes', validate(S.noteSchema), projects.addMyNote);
myProjectRoutes.put('/:id/steps/:stepId', validate(S.agentStepStatusSchema), projects.setMyStepStatus);
myProjectRoutes.post('/:id/steps/:stepId/photo', uploadStepPhoto, projects.uploadMyStepPhoto);
myProjectRoutes.put('/:id/amc/:visitId', validate(S.amcVisitCompleteSchema), projects.completeAmcVisitMine);
myProjectRoutes.get('/:id/amc/:visitId/invoice', invoiceParts, projects.amcPartsInvoiceMine);
myProjectRoutes.post('/:id/amc/:visitId/invoice', invoiceParts, validate(S.amcPartsInvoiceSchema), projects.invoiceAmcPartsMine);
myProjectRoutes.post('/:id/amc/:visitId/invoice/pdf', invoiceParts, uploadInvoicePdf, projects.attachAmcPartsInvoicePdfMine);
