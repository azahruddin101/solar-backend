import { Router } from 'express';
import * as google from '../controllers/google.controller.js';
import { authenticateMapAccess, authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';

export const solarRoutes = Router();
solarRoutes.get('/', google.solar);

// The satellite image is loaded by <img> / WebGL, which cannot send headers, so it accepts a short-lived map token.
export const staticMapRoutes = Router();
staticMapRoutes.get('/token', authenticate, requireRole(ROLES.COMPANY), google.mapToken);
staticMapRoutes.get('/', authenticateMapAccess, requireRole(ROLES.COMPANY), google.staticMap);
