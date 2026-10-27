// Finishing the last installation step completes the installation: AMC visits are created, a booking the client made
// before the install is carried onto its visit, and the completion is logged on the proposal.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Project } from '../src/models/index.js';
import { updateStep } from '../src/services/project.service.js';

let server;
before(async () => { server = await MongoMemoryServer.create(); await mongoose.connect(server.getUri()); });
after(async () => { await mongoose.disconnect(); await server?.stop(); });

test('finishing the last step completes the installation and schedules the AMC visits', async () => {
  const company = await Company.create({ name: 'Acme', amcTemplates: [{ name: 'AMC1', kind: 'mandatory', price: 0, daysAfterInstallation: 60, criteria: ['Panel cleaning', 'Wiring Check'] }, { name: 'AMC2', kind: 'optional', price: 9000 }] });
  const client = await Client.create({ company: company._id, name: 'Vinod' });
  const design = await Design.create({ company: company._id, client: client._id, name: 'D', status: 'won', amcRequests: [{ packageName: 'AMC2', requestedDate: new Date(), status: 'requested' }] });
  const user = { _id: new mongoose.Types.ObjectId(), id: 'u', name: 'Owner', role: 'company' };
  const project = await Project.create({ company: company._id, design: design._id, client: client._id, steps: [{ name: 'A', status: 'done', completedAt: new Date() }, { name: 'B', status: 'in_progress' }] });
  const res = await updateStep(company, user, project.id, project.steps[1].id, { status: 'done', lat: 26.87, lng: 81.01 });
  assert.equal(res.status, 'completed');
  const saved = await Project.findById(project._id);
  assert.deepEqual(saved.amcVisits.map((v) => v.name).sort(), ['AMC1', 'AMC2']);
  const booked = saved.amcVisits.find((v) => v.name === 'AMC2');
  assert.equal(String(booked.request), String((await Design.findById(design._id)).amcRequests[0]._id)); // the early booking became this visit
  assert.equal((await Design.findById(design._id)).logs.at(-1).action, 'installation_completed');
});
