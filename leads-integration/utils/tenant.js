const mongoose = require('mongoose');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const companyObjectId = (id) => {
  if (!id) return null;
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
};

const integrationQuery = (companyId) => ({ company: companyObjectId(companyId) });

const leadCompanyFilter = (companyId) => ({ company: companyObjectId(companyId) });

const runWithLeadCompany = (companyId, fn) => als.run({ companyId: String(companyId) }, fn);

const getLeadCompanyId = () => als.getStore()?.companyId || null;

module.exports = {
  companyObjectId,
  integrationQuery,
  leadCompanyFilter,
  runWithLeadCompany,
  getLeadCompanyId,
};
