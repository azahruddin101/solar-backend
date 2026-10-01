import { Router } from 'express';
import * as google from '../controllers/google.controller.js';
import { authenticateMapAccess, authenticate, hasPermission } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { Design } from '../models/index.js';
import { forbidden } from '../utils/HttpError.js';

export const solarRoutes = Router();
solarRoutes.get('/', google.solar);

/** The company owner, a client (their own proposals only, see below), or staff who can view designs. */
function mapViewerOnly(req, res, next) {
  if (req.user.role === ROLES.CLIENT || req.user.role === ROLES.COMPANY || hasPermission(req.user, 'designs', 'view')) return next();
  throw forbidden();
}

/** A client may only load satellite imagery near the sites of their own proposals (about 2 km), never arbitrary places. */
async function clientSiteOnly(req, res, next) {
  if (req.user.role !== ROLES.CLIENT) return next();
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const designs = await Design.find({ company: req.user.company, client: req.user.client, status: { $ne: 'draft' } }).select('data.origin').lean();
  const near = designs.some((d) => d.data?.origin && Math.abs(d.data.origin.lat - lat) < 0.02 && Math.abs(d.data.origin.lng - lng) < 0.02);
  if (!near) throw forbidden('This location is not part of your proposals');
  next();
}

// The satellite image is loaded by <img> / WebGL, which cannot send headers, so it accepts a short-lived map token.
export const staticMapRoutes = Router();
staticMapRoutes.get('/token', authenticate, mapViewerOnly, google.mapToken);
staticMapRoutes.get('/', authenticateMapAccess, mapViewerOnly, clientSiteOnly, google.staticMap);
