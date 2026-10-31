// The date a status change books (a callback, a site visit…). Statuses with `requiresDate` must get one; any other
// status may carry one too. Stored on the lead as `scheduledAt` so the lists can show what is coming up.
const DAY = 24 * 60 * 60 * 1000;

/** { scheduledAt: Date|null } or { error } from the request body for the chosen status. */
function readScheduledAt(body, status) {
  const raw = body && body.scheduledAt;
  if (raw === undefined || raw === null || raw === '') {
    if (status && status.requiresDate) return { error: `Choose a date for “${status.name}”` };
    return { scheduledAt: null };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { error: 'The date is not valid' };
  return { scheduledAt: date };
}

/** Mongo conditions on `scheduledAt` for ?schedule=upcoming|today|overdue|any (none for an unknown value). */
function scheduleCondition(value, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + DAY);
  switch (String(value || '')) {
    case 'upcoming': return { scheduledAt: { $gte: start } }; // today onward
    case 'today': return { scheduledAt: { $gte: start, $lt: end } };
    case 'overdue': return { scheduledAt: { $lt: start } }; // the date has passed and the lead is still in that status
    case 'any': return { scheduledAt: { $ne: null } };
    case 'rescheduled': return { rescheduledCount: { $gt: 0 } }; // the date was moved at least once
    default: return null;
  }
}

/**
 * A reschedule: the lead already had a date and the status change books a different one. Returns the `$set` / `$push`
 * pieces to merge into the status update (the earlier date is kept in previousSchedules, rescheduledCount goes up).
 */
function rescheduleUpdate(lead, scheduledAt, { statusName = '', byName = '', at = new Date() } = {}) {
  const had = lead && lead.scheduledAt ? new Date(lead.scheduledAt) : null;
  const rescheduled = Boolean(had && scheduledAt && had.getTime() !== new Date(scheduledAt).getTime());
  if (!rescheduled) return { rescheduled: false, set: {}, push: {} };
  return {
    rescheduled: true,
    set: { rescheduledCount: (lead.rescheduledCount || 0) + 1, isRescheduled: true },
    push: { previousSchedules: { scheduledAt: had, statusName, replacedAt: at, byName } },
  };
}

/** The lead-log line for a status change: "Callback · Fri 30 Oct 2026 · remark", as a reschedule when the date moved. */
function statusLogEntry({ status, scheduledAt, remark = '', rescheduled = false, byName = '', at = new Date() }) {
  const parts = [status.name];
  if (scheduledAt) parts.push(new Date(scheduledAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
  if (remark) parts.push(remark);
  return { action: rescheduled ? 'lead_rescheduled' : 'lead_status', message: parts.join(' · '), byName, at };
}

module.exports = { readScheduledAt, scheduleCondition, rescheduleUpdate, statusLogEntry };
