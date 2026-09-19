import { Router } from 'express';
import * as google from '../controllers/google.controller.js';

export const solarRoutes = Router();
solarRoutes.get('/', google.solar);

export const staticMapRoutes = Router();
staticMapRoutes.get('/', google.staticMap);
