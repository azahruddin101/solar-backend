import { Router } from 'express';
import * as agents from '../controllers/agent.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadAgentPhoto } from '../middlewares/upload.middleware.js';

const router = Router();

router.get('/', agents.list);
router.post('/', validate(S.agentCreateSchema), agents.create);
router.put('/:id', validate(S.agentUpdateSchema), agents.update);
router.post('/:id/photo', uploadAgentPhoto, agents.uploadPhoto);
router.delete('/:id/photo', agents.removePhoto);
router.delete('/:id', agents.remove);

export default router;
