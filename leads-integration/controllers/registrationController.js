const notEnabled = () => {
  const error = new Error('Student registration from leads is not enabled on this platform.');
  error.statusCode = 400;
  throw error;
};

module.exports = {
  startRegistrationForMetaLead: notEnabled,
  startRegistrationForInboxLead: notEnabled,
};
