import { Design } from '../models/index.js';

// The first version of the share link used a sparse unique index, which still counts `null` as a value. Replace it with the
// partial index the model now declares, and turn any stored null into "no link".
export async function fixShareTokenIndex() {
  try {
    const c = Design.collection;
    const old = (await c.indexes()).find((i) => i.name === 'shareToken_1');
    if (old) await c.dropIndex('shareToken_1');
    await c.updateMany({ shareToken: null }, { $unset: { shareToken: '' } });
    await Design.createIndexes();
  } catch (e) {
    console.warn(`Could not update the proposal share-link index: ${e.message}`);
  }
}
