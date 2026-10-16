const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  { email: String, name: String, role: String, tokenVersion: Number, active: Boolean, phone: String },
  { collection: 'users', strict: false },
);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
