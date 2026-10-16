const mongoose = require('mongoose');
const schema = new mongoose.Schema({}, { strict: false, collection: 'websiteleads' });
module.exports = mongoose.models.WebsiteLead || mongoose.model('WebsiteLead', schema);
