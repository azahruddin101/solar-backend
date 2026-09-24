import { packageService } from '../services/package.service.js';

export const packageController = {
  list: async (req, res, next) => {
    try {
      res.json(await packageService.list(req.company));
    } catch (err) {
      next(err);
    }
  },

  get: async (req, res, next) => {
    try {
      res.json(await packageService.get(req.company, req.params.id));
    } catch (err) {
      next(err);
    }
  },

  create: async (req, res, next) => {
    try {
      res.status(201).json(await packageService.create(req.company, req.body));
    } catch (err) {
      next(err);
    }
  },

  update: async (req, res, next) => {
    try {
      res.json(await packageService.update(req.company, req.params.id, req.body));
    } catch (err) {
      next(err);
    }
  },

  delete: async (req, res, next) => {
    try {
      res.json(await packageService.delete(req.company, req.params.id));
    } catch (err) {
      next(err);
    }
  },
};
