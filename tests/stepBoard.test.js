// The installation Kanban: a column per workflow step plus Completed; each installation sits in the column of the
// step it is on, urgent and stuck ones first. An agent sees the installations they are on, their own steps marked.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Project, User } from '../src/models/index.js';
import { stepBoard } from '../src/services/project.service.js';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
let server;
let company;
let client;
let ravi;

before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  company = await Company.create({ name: 'Acme Solar', installationSteps: [{ name: 'Survey' }, { name: 'Wiring' }, { name: 'Handover' }] });
  client = await Client.create({ company: company._id, name: 'Sita' });
  ravi = await User.create({ email: 'r@x.test', passwordHash: 'x', role: 'agent', name: 'Ravi', company: company._id });
});

const design = (name) => Design.create({ company: company._id, client: client._id, name, status: 'won', summary: { cost: 1 } });

test('a column per workflow step and Completed; each installation in the column of its current step', async () => {
  const [a, b, c, d] = await Promise.all(['Alpha', 'Beta', 'Closed', 'Custom'].map(design));
  await Project.create({ company: company._id, design: a._id, client: client._id, steps: [
    { name: 'Survey', status: 'done', completedAt: daysAgo(3) },
    { name: 'Wiring', status: 'in_progress', startedAt: daysAgo(9), assignee: ravi._id, priority: 'low' },
    { name: 'Handover', status: 'pending' },
  ] });
  await Project.create({ company: company._id, design: b._id, client: client._id, steps: [
    { name: 'Survey', status: 'done', completedAt: daysAgo(1) },
    { name: 'Wiring', status: 'pending', priority: 'urgent' },
    { name: 'Handover', status: 'pending' },
  ] });
  await Project.create({ company: company._id, design: c._id, client: client._id, status: 'completed', installationCompletedAt: daysAgo(2), steps: [{ name: 'Survey', status: 'done' }] });
  await Project.create({ company: company._id, design: d._id, client: client._id, steps: [{ name: 'Survey', status: 'done' }, { name: 'Permit', status: 'pending' }] }); // a step the workflow doesn't have

  const board = await stepBoard(company);
  assert.deepEqual(board.columns.map((col) => [col.id, col.count]), [['Survey', 0], ['Wiring', 2], ['Handover', 0], ['Permit', 1], ['completed', 1]]);
  const wiring = board.columns[1].cards;
  assert.deepEqual(wiring.map((card) => card.project), ['Alpha', 'Beta']); // the stuck one first, then urgent
  assert.equal(wiring[0].current.stuck, true);
  assert.equal(wiring[0].current.assignee.name, 'Ravi');
  assert.deepEqual([wiring[0].done, wiring[0].total, wiring[0].next.name], [1, 3, 'Handover']);
  assert.equal(wiring[1].current.status, 'pending');
  assert.equal(board.columns[4].cards[0].next, null);
  assert.equal(board.columns[4].cards[0].current, null);
  assert.deepEqual([board.total, board.open], [4, 3]);
});

test('an agent gets the installations they hold a step in, with their own steps marked', async () => {
  const [a, b] = await Promise.all(['Alpha', 'Beta'].map(design));
  await Project.create({ company: company._id, design: a._id, client: client._id, steps: [{ name: 'Survey', status: 'pending', assignee: ravi._id }, { name: 'Wiring', status: 'pending' }] });
  await Project.create({ company: company._id, design: b._id, client: client._id, steps: [{ name: 'Survey', status: 'pending' }] });
  const board = await stepBoard({ _id: company._id }, { agentId: ravi._id });
  assert.deepEqual(board.columns[0].cards.map((card) => [card.project, card.current.mine, card.steps.map((s) => s.mine)]), [['Alpha', true, [true, false]]]);
});
