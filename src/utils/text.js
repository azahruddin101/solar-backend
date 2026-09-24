/** "nos" → "Nos": upper-case the first letter, leave the rest as typed. */
export const capFirst = (value) => {
  const s = String(value ?? '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
};

/** "ravi kumar" → "Ravi Kumar": upper-case the first letter of every word, leave the rest as typed ("D'Souza", "McDonald" stay). */
export const capWords = (value) => String(value ?? '').trim().replace(/(^|\s)(\p{L})/gu, (m, space, letter) => space + letter.toUpperCase());
