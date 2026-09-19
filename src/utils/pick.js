/** Copy only the allowed keys that are present on the body (mass-assignment guard). */
export function pick(body, keys) {
  const out = {};
  for (const k of keys) if (body?.[k] !== undefined) out[k] = body[k];
  return out;
}
