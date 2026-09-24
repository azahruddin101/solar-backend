import { Router } from 'express';
import * as projects from '../controllers/project.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadStepPhoto } from '../middlewares/upload.middleware.js';

/** Company owner: step template + every installation. */
export const projectRoutes = Router();
projectRoutes.get('/steps', projects.getSteps);
projectRoutes.put('/steps', projects.updateSteps);
projectRoutes.get('/', projects.list);
projectRoutes.post('/', validate(S.projectStartSchema), projects.start);
projectRoutes.get('/:id/lifecycle', projects.lifecycle);
projectRoutes.get('/:id', projects.get);
projectRoutes.delete('/:id', projects.remove);
projectRoutes.post('/:id/notes', validate(S.noteSchema), projects.addNote);
projectRoutes.post('/:id/steps', validate(S.stepCreateSchema), projects.addStep);
projectRoutes.put('/:id/steps/:stepId', validate(S.stepUpdateSchema), projects.updateStep);
projectRoutes.post('/:id/steps/:stepId/photo', uploadStepPhoto, projects.uploadStepPhoto);
projectRoutes.delete('/:id/steps/:stepId', projects.removeStep);

/** Agent: only the installations they hold a step in. */
export const myProjectRoutes = Router();
myProjectRoutes.get('/', projects.listMine);
myProjectRoutes.get('/:id/lifecycle', projects.lifecycleMine);
myProjectRoutes.get('/:id', projects.getMine);
myProjectRoutes.post('/:id/notes', validate(S.noteSchema), projects.addMyNote);
myProjectRoutes.put('/:id/steps/:stepId', validate(S.agentStepStatusSchema), projects.setMyStepStatus);
myProjectRoutes.post('/:id/steps/:stepId/photo', uploadStepPhoto, projects.uploadMyStepPhoto);
