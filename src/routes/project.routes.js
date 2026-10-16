import { Router } from 'express';
import * as projects from '../controllers/project.controller.js';
import { permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadStepPhoto } from '../middlewares/upload.middleware.js';

/** Company owner: step template + every installation. */
export const projectRoutes = Router();
const view = permissionOnly('tasks', 'view');
const create = permissionOnly('tasks', 'create');
const update = permissionOnly('tasks', 'update');
const del = permissionOnly('tasks', 'delete');
const status = permissionOnly('tasks', 'change_status');
// a step update may edit, (re)assign or change the status; the service checks the permission for each part it changes
const anyStepChange = permissionOnly('tasks', 'update', 'assign', 'change_status');

projectRoutes.get('/steps', view, projects.getSteps);
// the installation step template is a company master: only the owner changes it
projectRoutes.put('/steps', requireRole(ROLES.COMPANY), projects.updateSteps);
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

/** Agent: only the installations they hold a step in. */
export const myProjectRoutes = Router();
myProjectRoutes.get('/', projects.listMine);
myProjectRoutes.get('/:id/lifecycle', projects.lifecycleMine);
myProjectRoutes.get('/:id', projects.getMine);
myProjectRoutes.post('/:id/notes', validate(S.noteSchema), projects.addMyNote);
myProjectRoutes.put('/:id/steps/:stepId', validate(S.agentStepStatusSchema), projects.setMyStepStatus);
myProjectRoutes.post('/:id/steps/:stepId/photo', uploadStepPhoto, projects.uploadMyStepPhoto);
