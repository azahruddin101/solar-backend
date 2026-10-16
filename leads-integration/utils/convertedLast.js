const MetaLeadStatus = require('../models/MetaLeadStatus');
const { leadCompanyFilter } = require('./tenant');

// Lead lists show converted ("registered") leads last: every other status first, then the converted ones, each part
// in the list's usual order. Done with two plain queries (the leads before and after the cut), so filters, paging and
// totals work exactly as before.

/** Ids of the company's converted status (the one with outcome "converted"; older data may only carry isConversion). */
const convertedStatusIds = (companyId) =>
  MetaLeadStatus.distinct('_id', { ...leadCompanyFilter(companyId), $or: [{ outcome: 'converted' }, { isConversion: true }] });

/**
 * One page of `filter`, converted leads last.
 * `converted`: the condition that marks a converted lead (null when the company has none, then the order is unchanged).
 * `query(cond)`: builds the find (sort, populate, select…) for `{ $and: [filter, cond] }`, without skip/limit.
 */
const pageConvertedLast = async (Model, filter, converted, query, { skip, limit }) => {
  if (!converted) return query(filter).skip(skip).limit(limit).lean();
  const before = { $and: [filter, { $nor: [converted] }] };
  const after = { $and: [filter, converted] };
  const nBefore = await Model.countDocuments(before);
  const fromBefore = skip < nBefore ? await query(before).skip(skip).limit(limit).lean() : [];
  const left = limit - fromBefore.length;
  const fromAfter = left > 0 ? await query(after).skip(Math.max(0, skip - nBefore)).limit(left).lean() : [];
  return [...fromBefore, ...fromAfter];
};

module.exports = { convertedStatusIds, pageConvertedLast };
