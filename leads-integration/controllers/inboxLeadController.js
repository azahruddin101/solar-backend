const detailFields = (lead) => lead?.fields || {};
const sourceLabelFor = (source) => source || 'Meta';

module.exports = { detailFields, sourceLabelFor };
