// A small in-memory cache that cannot grow without end: it keeps the `max` entries used most recently and drops
// the oldest beyond that. For answers that are also kept in the database (the memory copy only saves a query),
// so an entry that falls out costs one read, never a wrong answer.
export function boundedCache(max) {
  const map = new Map(); // a Map keeps its keys in the order they were set: the first key is the oldest
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key); // used again: move it to the newest end
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}
