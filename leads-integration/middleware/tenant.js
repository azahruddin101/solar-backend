const { runWithLeadCompany } = require('../utils/tenant');

/** After JWT auth: every leads API call is scoped to the signed-in company workspace. */
const bindLeadsTenant = (req, res, next) => {
  const company = req.user?.company;
  if (!company) {
    return res.status(403).json({ message: 'Lead integrations are only available inside a company workspace.' });
  }
  req.leadsCompanyId = String(company);
  return runWithLeadCompany(req.leadsCompanyId, () => next());
};

module.exports = { bindLeadsTenant };
