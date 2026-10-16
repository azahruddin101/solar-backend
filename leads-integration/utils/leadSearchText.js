const buildSearchText = (...values) =>
  values
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

module.exports = { buildSearchText };
