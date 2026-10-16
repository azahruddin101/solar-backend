const narrowRange = () => null;
const sessionFilter = () => ({});

const resolveSessionScope = async () => ({
  sessionScope: { session: null, range: null },
});

module.exports = { narrowRange, sessionFilter, resolveSessionScope };
