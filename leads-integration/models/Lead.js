const mongoose = require('mongoose');
const schema = new mongoose.Schema({}, { strict: false, collection: 'leads' });
module.exports = mongoose.models.Lead || mongoose.model('Lead', schema);
