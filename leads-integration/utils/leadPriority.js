const mongoose = require('mongoose');
const { leadCompanyFilter } = require('./tenant');
const { assignedScope } = require('./leadScope');

// Reads the ?priority= list filter: 'true' (priority leads only), 'false' (the rest), or empty (all).
const readPriorityFilter = (value) => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return { priority: null, invalid: false };
  if (raw === 'true') return { priority: true, invalid: false };
  if (raw === 'false') return { priority: false, invalid: false };
  return { priority: null, invalid: true };
};

// Mongo condition for isPriority. Leads saved before the flag existed have no value and count as not priority.
const priorityCondition = (priority) => (priority ? true : { $ne: true });

// Express handler that turns the priority flag on or off for one lead of the signed-in company.
// `scope(req)` may return extra conditions the lead must meet (for example, only processed Meta leads).
const setLeadPriority = (Model, scope = () => ({})) => async (req, res) => {
  if (!req.leadsCompanyId) return res.status(403).json({ message: 'Lead integrations are only available inside a company workspace.' });
  const isPriority = req.body ? req.body.isPriority : undefined;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  if (typeof isPriority !== 'boolean') return res.status(400).json({ message: 'Choose whether the lead is a priority' });

  try {
    const lead = await Model.findOneAndUpdate(
      { ...scope(req), _id: req.params.id, isDeleted: { $ne: true }, ...assignedScope(req), ...leadCompanyFilter(req.leadsCompanyId) },
      { $set: { isPriority } },
      { returnDocument: 'after' }
    ).select('_id isPriority').lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    res.json({ _id: lead._id, isPriority: Boolean(lead.isPriority) });
  } catch (error) {
    res.status(500).json({ message: 'Server error updating the lead priority' });
  }
};

module.exports = { readPriorityFilter, priorityCondition, setLeadPriority };
