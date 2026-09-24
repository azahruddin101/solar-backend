import * as subscriptionService from '../services/subscription.service.js';

export async function getSubscription(req, res) {
  res.json(await subscriptionService.subscriptionView(req.company));
}

export async function listUpgrades(req, res) {
  res.json(await subscriptionService.listUpgradeOptions(req.company));
}

export async function quoteUpgrade(req, res) {
  res.json(await subscriptionService.quoteCompanyUpgrade(req.company, req.query.planId));
}
