import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import mongoose from 'mongoose';

const require = createRequire(import.meta.url);
const { assignedScope } = require('../leads-integration/utils/leadScope.js');
const { leadVisibilityFilter } = require('../leads-integration/utils/leadAssignment.js');

test('assignedScope applies team filter including assignment history', () => {
  const id1 = new mongoose.Types.ObjectId();
  const id2 = new mongoose.Types.ObjectId();
  const scope = { $in: [id1, id2] };
  const req = { leadsAssignedTo: null, leadsAssignedScope: scope };
  assert.deepEqual(assignedScope(req), {
    $or: [
      { assignedTo: scope },
      { 'assignmentHistory.assignee': scope },
    ],
  });
});

test('assignedScope includes past assignments for single assignee', () => {
  const id = new mongoose.Types.ObjectId();
  const req = { leadsAssignedTo: id, leadsAssignedScope: null };
  assert.deepEqual(assignedScope(req), leadVisibilityFilter(id));
});

test('assignedScope is empty for view-all (no scope on request)', () => {
  assert.deepEqual(assignedScope({}), {});
});
