// Wraps a route handler that returns a value (or throws) into an Express handler that JSON-responds
// with it and forwards errors to the error middleware, so routes don't repeat try/catch.
export const wrap = (fn, status) => async (req, res, next) => {
  try {
    res.status(status || 200).json(await fn(req));
  } catch (err) {
    next(err);
  }
};
