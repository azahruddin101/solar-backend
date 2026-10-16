// Schedules a company's Google Sheet export after one of its leads is created, updated, or removed.
// The sync module is loaded only when a write actually happens, so models can
// register these hooks without a circular require.

const hasChanges = (result) => {
  if (!result) return false;
  if (Array.isArray(result)) return result.length > 0;
  const counts = ['modifiedCount', 'deletedCount', 'insertedCount', 'upsertedCount'];
  const isWriteResult = counts.some((key) => Object.prototype.hasOwnProperty.call(result, key));
  if (!isWriteResult) return true;
  return counts.reduce((sum, key) => sum + (result[key] || 0), 0) > 0;
};

// The company the change belongs to: from the saved document(s), or from the query's filter (lead queries are
// always tenant-scoped). Unknown → nothing to sync.
const companyOf = (result, query) => {
  const doc = Array.isArray(result) ? result[0] : result;
  if (doc && doc.company) return String(doc.company._id || doc.company);
  const filter = query && typeof query.getFilter === 'function' ? query.getFilter() : null;
  const company = filter && filter.company;
  return company && (typeof company === 'string' || company._bsontype || company.toHexString) ? String(company) : null;
};

const schedule = (result, query) => {
  if (process.env.NODE_ENV === 'test') return;
  if (!hasChanges(result)) return;
  const companyId = companyOf(result, query);
  if (!companyId) return;
  setImmediate(() => {
    try {
      require('./googleSheetSync').scheduleLeadSheetSync(companyId);
    } catch (error) {
      console.error('[SHEETS] Could not schedule lead sync:', error.message);
    }
  });
};

// Lead fields the sheet is built from (see utils/leadRows.js): the details, status and assignee. Changes to
// anything else (priority, logs…) leave the sheet unchanged, so they do not trigger a full re-export.
const SHEET_FIELDS = new Set([
  'fullName', 'name', 'email', 'phone', 'address', 'fields', 'source', 'leadCreatedAt', 'createdAt', 'isDeleted',
  'processingStatus', 'status', 'statusName', 'adminStatus', 'assignedTo',
]);
// A Meta lead's status lives on its active assignment
const ASSIGNMENT_FIELDS = new Set(['currentStatus', 'isActive', 'telecaller', 'lead']);

const updateTouchesSheet = (query, fields = SHEET_FIELDS) => {
  const touchesSheetPath = (path) => fields.has(String(path).split('.')[0]);
  const options = (query && typeof query.getOptions === 'function' && query.getOptions()) || {};
  if (options.upsert) return true;
  const update = query && typeof query.getUpdate === 'function' ? query.getUpdate() : null;
  if (!update || Array.isArray(update)) return true;
  return Object.entries(update).some(([key, value]) => {
    if (!key.startsWith('$')) return touchesSheetPath(key);
    if (!value || typeof value !== 'object') return true;
    return Object.keys(value).some(touchesSheetPath);
  });
};

const attachLeadSheetHooks = (schema, fields = SHEET_FIELDS) => {
  const touchesSheetPath = (path) => fields.has(String(path).split('.')[0]);
  schema.pre('save', function rememberSheetChange() {
    this.$locals.touchesSheet = this.isNew || this.modifiedPaths().some(touchesSheetPath);
  });
  schema.post('save', function saved() {
    if (this.$locals.touchesSheet === false) return;
    schedule(this);
  });
  // one-argument hooks only: Mongoose treats a second parameter as a `next` callback and would wait for it
  schema.post('insertMany', function inserted(docs) {
    schedule(docs);
  });
  const scheduleIfRelevant = function scheduleIfRelevant(result) {
    if (!updateTouchesSheet(this, fields)) return;
    schedule(result, this);
  };
  const scheduleAlways = function scheduleAlways(result) {
    schedule(result, this);
  };
  schema.post('findOneAndUpdate', scheduleIfRelevant);
  schema.post('updateOne', scheduleIfRelevant);
  schema.post('updateMany', scheduleIfRelevant);
  schema.post('findOneAndDelete', scheduleAlways);
  schema.post('deleteOne', scheduleAlways);
  schema.post('deleteMany', scheduleAlways);
  schema.post('findOneAndReplace', scheduleAlways);
  schema.post('replaceOne', scheduleAlways);
};

module.exports = { attachLeadSheetHooks, updateTouchesSheet, SHEET_FIELDS, ASSIGNMENT_FIELDS };
