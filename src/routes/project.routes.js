import { Router } from 'express';
import * as projects from '../controllers/project.controller.js';
import { permissionOnly } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadStepPhoto } from '../middlewares/upload.middleware.js';

/** Company owner: step template + every installation. */
export const projectRoutes = Router();
const view = permissionOnly('installations', 'view');
const create = permissionOnly('installations', 'create');
const update = permissionOnly('installations', 'update');
const del = permissionOnly('installations', 'delete');

projectRoutes.get('/steps', view, projects.getSteps);
projectRoutes.put('/steps', update, projects.updateSteps);
projectRoutes.get('/', view, projects.list);
projectRoutes.post('/', create, validate(S.projectStartSchema), projects.start);
projectRoutes.get('/:id/lifecycle', view, projects.lifecycle);
projectRoutes.get('/:id', view, projects.get);
projectRoutes.delete('/:id', del, projects.remove);
projectRoutes.post('/:id/notes', update, validate(S.noteSchema), projects.addNote);
projectRoutes.post('/:id/steps', update, validate(S.stepCreateSchema), projects.addStep);
projectRoutes.put('/:id/steps/:stepId', update, validate(S.stepUpdateSchema), projects.updateStep);
projectRoutes.post('/:id/steps/:stepId/photo', update, uploadStepPhoto, projects.uploadStepPhoto);
projectRoutes.delete('/:id/steps/:stepId', del, projects.removeStep);

/** Agent: only the installations they hold a step in. */
export const myProjectRoutes = Router();
myProjectRoutes.get('/', projects.listMine);
myProjectRoutes.get('/:id/lifecycle', projects.lifecycleMine);
myProjectRoutes.get('/:id', projects.getMine);
myProjectRoutes.post('/:id/notes', validate(S.noteSchema), projects.addMyNote);
myProjectRoutes.put('/:id/steps/:stepId', validate(S.agentStepStatusSchema), projects.setMyStepStatus);
myProjectRoutes.post('/:id/steps/:stepId/photo', uploadStepPhoto, projects.uploadMyStepPhoto);
