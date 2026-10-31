import { Router } from 'express';
import { counts, dashboard, today } from '../services/dashboard.service.js';

const router = Router();
router.get('/counts', async (req, res, next) => {
  try {
    res.json(await counts(req.company));
  } catch (err) {
    next(err);
  }
});
router.get('/today', async (req, res, next) => {
  try {
    res.json(await today(req.company));
  } catch (err) {
    next(err);
  }
});
router.get('/', async (req, res, next) => {
  try {
    res.json(await dashboard(req.company));
  } catch (err) {
    next(err);
  }
});

export default router;
