// "Refer someone" in the client portal: a referral becomes a lead of the client's company, and the client is told
// only when it is converted or lost.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Notification, User } from '../src/models/index.js';
import { leadModels } from '../src/integrations/leads.js';
import { createReferral, listReferrals, referralForm, syncReferralOutcome } from '../src/services/referral.service.js';

let server;
let company;
let client;
let user;
let owner;
const status = {};
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  // the company's lead form: Name, Phone, Address and two fields of its own (one required)
  company = await Company.create({ name: 'Sunrise Solar', leadForm: [{ key: 'monthly_bill', label: 'Monthly bill', type: 'number', required: true }, { key: 'roof', label: 'Roof', type: 'select', options: ['Flat', 'Sloped'] }] });
  client = await Client.create({ company: company._id, name: 'Asha Rao', phone: '9811122233', email: 'asha@example.com' });
  user = await User.create({ email: 'asha@example.com', passwordHash: 'x', name: 'Asha Rao', role: 'client', company: company._id, client: client._id });
  owner = await User.create({ email: 'owner@example.com', passwordHash: 'x', name: 'Owner', role: 'branch', company: company._id });
  for (const [name, outcome] of [['Interested', 'open'], ['Converted', 'converted'], ['Lost', 'lost']]) {
    status[outcome] = await leadModels.status.create({ company: company._id, name, nameKey: name.toLowerCase(), outcome, isConversion: outcome === 'converted' });
  }
});
after(async () => { await mongoose.disconnect(); await server?.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150)); // notifications are sent after the reply
const setStatus = async (id, s) => {
  await leadModels.manual.updateOne({ _id: id }, { $set: { status: s._id, statusName: s.name } });
  return syncReferralOutcome(company._id, id);
};
const inbox = (u) => Notification.find({ user: u._id }).sort({ createdAt: 1 }).lean();

test('a referral becomes a referral lead of the client’s company, and the company is told', async () => {
  assert.deepEqual((await referralForm(user)).fields.map((f) => f.key), ['name', 'phone', 'address', 'monthly_bill', 'roof']); // the company's own form
  const made = await createReferral(user, { name: 'Ravi Kumar', phone: '+91 98765 43210', address: 'Camp, Pune', monthly_bill: '4500', roof: 'Flat', note: 'My neighbour' });
  assert.deepEqual([made.name, made.outcome, made.outcomeAt], ['Ravi Kumar', 'open', null]);
  const lead = await leadModels.manual.findById(made.id).lean();
  assert.deepEqual([lead.source, String(lead.company), String(lead.referredByClient), lead.referredByClientName, lead.phoneKey], ['referral', String(company._id), String(client._id), 'Asha Rao', '9876543210']);
  assert.match(lead.logs[0].message, /Referred by client Asha Rao: My neighbour/);
  assert.deepEqual(lead.fields, { monthly_bill: 4500, roof: 'Flat' }); // the company's fields, as on a lead added by staff
  assert.deepEqual([lead.referredByClientPhone, lead.referredByClientEmail], ['9811122233', 'asha@example.com']); // the client's own details stay with it
  await settle();
  const told = await inbox(owner);
  assert.deepEqual([told.length, told[0].type, told[0].body], [1, 'referral_added', 'Asha Rao referred Ravi Kumar']);
});

test('the same person is not referred twice, and a name and number are needed', async () => {
  await assert.rejects(() => createReferral(user, { name: 'Ravi K', phone: '9876543210', monthly_bill: 100 }), /already referred this person/);
  // checked as the company's form is: what it requires is required here too, problem by field
  const refused = await createReferral(user, { name: 'Meera Joshi', phone: '9876500000', roof: 'Dome' }).catch((e) => e);
  assert.equal(refused.status, 400);
  assert.deepEqual(Object.keys(refused.details.errors).sort(), ['monthly_bill', 'roof']);
  await assert.rejects(() => createReferral(user, { name: '', phone: '9876500000', monthly_bill: 1 }), (e) => Boolean(e.details?.errors?.name));
});

test('the client hears about converted and lost, and about nothing else', async () => {
  const [ref] = await listReferrals(user);
  assert.equal(await setStatus(ref.id, status.open), null); // an ordinary status: nothing for the client
  await settle();
  assert.equal((await inbox(user)).length, 0);
  assert.equal((await listReferrals(user))[0].outcome, 'open');

  assert.equal(await setStatus(ref.id, status.converted), 'converted');
  assert.equal(await setStatus(ref.id, status.converted), null); // saved again: not told twice
  await settle();
  let told = await inbox(user);
  assert.deepEqual([told.length, told[0].type, told[0].path], [1, 'referral_converted', '/portal/refer']);
  assert.match(told[0].body, /Ravi Kumar.*has become a customer/);
  const shown = (await listReferrals(user))[0];
  assert.deepEqual(Object.keys(shown).sort(), ['createdAt', 'id', 'name', 'outcome', 'outcomeAt', 'phone']); // no status names, remarks or staff
  assert.equal(shown.outcome, 'converted');

  assert.equal(await setStatus(ref.id, status.lost), 'lost');
  await settle();
  told = await inbox(user);
  assert.deepEqual([told.length, told[1].type], [2, 'referral_lost']);
  assert.equal((await listReferrals(user))[0].outcome, 'lost');
});

test('a client sees only their own referrals, and other leads are left alone', async () => {
  const other = await Client.create({ company: company._id, name: 'Other Client' });
  const otherUser = await User.create({ email: 'other@example.com', passwordHash: 'x', name: 'Other', role: 'client', company: company._id, client: other._id });
  assert.deepEqual(await listReferrals(otherUser), []);
  await assert.rejects(() => createReferral(otherUser, { name: 'Ravi Kumar', phone: '98765 43210', monthly_bill: 900 }), /already have this person/);
  const plain = await leadModels.manual.create({ company: company._id, fullName: 'Walk In', phone: '9000000009', phoneKey: '9000000009', status: status.converted._id });
  assert.equal(await syncReferralOutcome(company._id, plain._id), null);
});
