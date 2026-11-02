// Which leads the signed-in user may work on. Set by scopeToOwnLeads on the leads router.
const { leadVisibilityFilter } = require('./leadAssignment');

/** Leads the user may SEE: assigned to them (or their team) now, or held by them before (their own history). */
const assignedScope = (req) => {
  if (req.leadsAssignedScope) return leadVisibilityFilter(req.leadsAssignedScope);
  if (req.leadsAssignedTo) return leadVisibilityFilter(req.leadsAssignedTo);
  return {};
};

/**
 * Leads the user may CHANGE (status, priority, details, assignment, conversion): only those assigned to them (or their
 * team) right now. A lead handed to someone else stays visible to its previous holder, read-only.
 */
const assignedWriteScope = (req) => {
  const scope = req.leadsAssignedScope || req.leadsAssignedTo;
  return scope ? { assignedTo: scope } : {};
};

/**
 * Adds the user's lead scope to a list filter with $and: the scope is itself an $or / assignedTo condition, so merging
 * it with Object.assign would silently replace the filter's own (e.g. "include past assignments").
 */
const withAssignedScope = (filter, req) => {
  const scope = assignedScope(req);
  if (Object.keys(scope).length) filter.$and = [...(filter.$and || []), scope];
  return filter;
};

module.exports = { assignedScope, assignedWriteScope, withAssignedScope };
