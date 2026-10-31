// A client-chosen key makes a create request safe to repeat: the second request with the same key returns the document
// the first one made instead of making another (which would take the stock or record the payment twice).

/** The key as sent: 8 to 64 letters, digits, - or _; anything else counts as no key. */
export const cleanIdempotencyKey = (value) => {
  const key = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : '';
};

/**
 * Run `create()` unless a document of `Model` already carries `key`: then `replay(thatDocument)` is returned.
 * Two requests with the same key at the same moment: one commits. The other fails (a key clash on insert, or "not in
 * stock" because the winner already took the goods), its transaction is rolled back, and it replays the winner.
 */
export async function createOnce(Model, company, key, create, replay) {
  if (!key) return create();
  const find = () => Model.findOne({ company: company._id, idempotencyKey: key }).lean();
  const existing = await find();
  if (existing) return replay(existing);
  try {
    return await create();
  } catch (e) {
    const winner = await find(); // whatever went wrong, a document with this key now means the request was served
    if (winner) return replay(winner);
    throw e;
  }
}

/** Mongoose field + unique index for a model's `idempotencyKey`. */
export const idempotencyField = { type: String, default: undefined };
export const idempotencyIndex = [{ company: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }];
