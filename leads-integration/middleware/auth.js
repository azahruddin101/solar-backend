// The leads routers are mounted inside the main app, behind its `authenticate` (backend/src/middlewares/
// auth.middleware.js), which verifies the token, the device session, the company's status and the account's state.
// This file used to verify the JWT a second time, with fewer checks; now it only insists that the main check ran.

const protect = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Not authorized' });
  return next();
};

/** Company owners manage their own lead integrations (one Meta / Google setup per company). */
const authorize = (...roles) => (req, res, next) => {
  const allowed = roles.length ? roles : ['company'];
  if (allowed.includes(req.user?.role)) return next();
  return res.status(403).json({ message: 'Forbidden' });
};

module.exports = { protect, authorize };
