const { convertedStatusIds } = require('./convertedLast');

const LOCK_MESSAGE = 'This lead is converted. Its status and assignment can no longer be changed.';

const isConvertedStatusId = (statusId, convertedIds) => {
  if (!statusId || !convertedIds?.length) return false;
  const s = String(statusId);
  return convertedIds.some((id) => String(id) === s);
};

/** True when the lead is linked to a client or already on the company's converted status. */
const isLeadStatusLocked = (lead, convertedIds) => {
  if (lead?.convertedClient) return true;
  const ids = [lead?.status, lead?.adminStatus, lead?.currentStatus].filter(Boolean);
  return ids.some((id) => isConvertedStatusId(id, convertedIds));
};

const assertLeadStatusMutable = async (companyId, lead) => {
  const convertedIds = await convertedStatusIds(companyId);
  if (isLeadStatusLocked(lead, convertedIds)) {
    return { ok: false, status: 409, message: LOCK_MESSAGE };
  }
  return { ok: true };
};

/** Block bulk assignment when any lead in `leads` is converted. */
const assertLeadsAssignmentMutable = async (companyId, leads, statusForLead) => {
  const convertedIds = await convertedStatusIds(companyId);
  for (const lead of leads) {
    const snapshot = statusForLead ? statusForLead(lead) : lead;
    if (isLeadStatusLocked(snapshot, convertedIds)) {
      return { ok: false, status: 409, message: LOCK_MESSAGE };
    }
  }
  return { ok: true };
};

module.exports = { LOCK_MESSAGE, isLeadStatusLocked, assertLeadStatusMutable, assertLeadsAssignmentMutable };
