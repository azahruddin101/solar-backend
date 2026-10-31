// Who has held a lead. Every assignment is kept in `assignmentHistory`, a hand-over from one person to another sets
// `isReassigned` (and counts), and `logs` tells the story. A staff member keeps a handed-over lead on their profile.
const assigneeName = (a) => (a && (a.name || a.email)) || '';

/**
 * The bulkWrite operations that move `lead` (its current assignedTo populated with name) to `assignee` (a user, or
 * null to take it away), done by `actor`. Two operations: close the open history entry, then apply the change.
 */
function leadAssignmentOps(Model, companyFilter, lead, assignee, actor, now = new Date()) {
  const prevId = lead.assignedTo ? lead.assignedTo._id || lead.assignedTo : null;
  const prevName = assigneeName(lead.assignedTo);
  const byName = assigneeName(actor);
  const filter = { ...companyFilter, _id: lead._id };
  const ops = [];
  const open = (lead.assignmentHistory || []).some((h) => !h.endedAt);
  if (open) { // close the entry of the person who holds it (a lead assigned before histories existed has none to close)
    ops.push({ updateOne: { filter, update: { $set: { 'assignmentHistory.$[open].endedAt': now } }, arrayFilters: [{ 'open.endedAt': null }] } });
  }
  if (prevId && !open) { // remember them anyway, so the hand-over is traceable
    ops.push({ updateOne: { filter, update: { $push: { assignmentHistory: { assignee: prevId, assigneeName: prevName, assignedAt: lead.assignedAt || null, endedAt: now, byName: '' } } } } });
  }
  if (assignee) {
    const name = assigneeName(assignee);
    const reassigned = Boolean(prevId);
    ops.push({ updateOne: { filter, update: {
      $set: { assignedTo: assignee._id, assignedAt: now, ...(reassigned ? { isReassigned: true } : {}) },
      ...(reassigned ? { $inc: { reassignedCount: 1 } } : {}),
      $push: {
        assignmentHistory: { assignee: assignee._id, assigneeName: name, assignedAt: now, endedAt: null, byName },
        logs: { action: reassigned ? 'lead_reassigned' : 'lead_assigned', message: reassigned ? `${prevName || 'Unassigned'} → ${name}` : name, byName, at: now },
      },
    } } });
  } else {
    ops.push({ updateOne: { filter, update: {
      $unset: { assignedTo: 1, assignedAt: 1 },
      $push: { logs: { action: 'lead_unassigned', message: prevName ? `Taken from ${prevName}` : '', byName, at: now } },
    } } });
  }
  return ops;
}

/** Apply `leadAssignmentOps` for every lead in one bulkWrite. */
async function applyLeadAssignments(Model, companyFilter, leads, assignee, actor, now = new Date()) {
  const ops = leads.flatMap((lead) => leadAssignmentOps(Model, companyFilter, lead, assignee, actor, now));
  if (ops.length) await Model.bulkWrite(ops, { ordered: true });
}

/** Mongo condition for ?assignedTo=<id> that also keeps leads this person held before (their performance), when asked. */
function heldByCondition(userId, { includePast = false } = {}) {
  if (!includePast) return { assignedTo: userId };
  return { $or: [{ assignedTo: userId }, { 'assignmentHistory.assignee': userId }] };
}

const ASSIGNMENT_FIELDS = 'assignmentHistory isReassigned reassignedCount isRescheduled logs';

module.exports = { leadAssignmentOps, applyLeadAssignments, heldByCondition, ASSIGNMENT_FIELDS };
