// The free proposal maker (public site): the sums, what is kept of the visitor, and what the visitor sees back.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FreeProposal } from '../src/models/index.js';
import { adminGetFreeProposal, adminUpdateFreeProposal, cleanProposal, countNewFreeProposals, createFreeProposal, getFreeProposal, listFreeProposals, parseUserAgent, proposalTotals, removeFreeProposal, updateFreeProposal } from '../src/services/freeProposal.service.js';

let server;
before(async () => { server = await MongoMemoryServer.create(); await mongoose.connect(server.getUri()); });
after(async () => { await mongoose.disconnect(); await server?.stop(); });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
const body = (extra = {}) => ({
  company: { name: 'Sunrise Solar', contactName: 'Asha Rao', phone: '98765 43210', email: 'ASHA@example.com' },
  client: { name: 'Ravi Kumar', address: 'Camp, Pune' },
  system: { title: '5 kW rooftop solar', type: 'On-grid', kw: 5, panelCount: 9, panelWatts: 550, annualKwh: 7000, tariff: 8 },
  items: [{ name: 'Solar panels', qty: 9, unit: 'Nos', rate: 15000, taxPercent: 12 }, { name: 'Installation', qty: 1, rate: 20000, taxPercent: 18 }, { name: '', qty: 3, rate: 5 }],
  pricing: { currency: 'INR', discount: 10, discountIsPercent: true, subsidy: 78000 },
  terms: { validUntil: '2026-12-31', payment: '50% advance' },
  design: { cover: 'panel', primary: '#0F6E56' },
  logo: LOGO,
  ...extra,
});

test('the amounts are worked out from quantity, rate, discount and tax', () => {
  // 9 × 15000 = 135000 and 1 × 20000 → 155000; 10% off → 139500; tax 12% of 121500 + 18% of 18000
  assert.deepEqual(proposalTotals(body().items.slice(0, 2), body().pricing), { subtotal: 155000, discountAmount: 15500, taxable: 139500, tax: 17820, total: 157320, subsidy: 78000, net: 79320 });
  assert.equal(proposalTotals([{ qty: 2, rate: 50 }], { discount: 500 }).total, 0); // a discount never goes past the price
});

test('only what the maker asks for is kept, and what it needs is asked for', () => {
  const c = cleanProposal({ ...body(), junk: 1, design: { cover: 'weird', primary: 'red' } });
  assert.equal(c.data.items.length, 2); // the line with no name is dropped
  assert.deepEqual([c.data.design.cover, c.data.design.primary], ['magazine', '#1D4ED8']);
  assert.equal(c.logo, LOGO);
  assert.equal(cleanProposal(body({ logo: 'javascript:alert(1)' })).logo, '');
  // the terms are rich text: kept as formatted, scripts stripped, plain lines become a list
  const t = cleanProposal(body({ terms: { payment: '<p><strong>50%</strong> advance<script>alert(1)</script></p>', conditions: 'First\nSecond', notes: '<p><br></p>' } })).data.terms;
  assert.deepEqual([t.payment, t.conditions, t.notes], ['<p><strong>50%</strong> advance</p>', '<ol><li>First</li><li>Second</li></ol>', '']);
  assert.throws(() => cleanProposal(body({ company: { name: 'S' } })), /company name/);
  assert.throws(() => cleanProposal(body({ client: {} })), /client/);
  assert.throws(() => cleanProposal(body({ system: { kw: 0 } })), /size of the system/);
  assert.throws(() => cleanProposal(body({ items: [] })), /at least one item/);
  assert.throws(() => cleanProposal(body({ items: [{ name: 'Panel', qty: 0, rate: 5 }] })), /quantity of Panel/);
});

test('the device is read from the user agent', () => {
  assert.deepEqual(parseUserAgent(IPHONE), { browser: 'Safari', os: 'iOS', type: 'mobile' });
});

test('a proposal is kept as a lead with device and location; the visitor gets only their own part and can edit it', async () => {
  const made = await createFreeProposal({ ...body(), device: { screen: '390x844', language: 'en-IN', timezone: 'Asia/Kolkata', platform: 'iPhone' }, position: { lat: 18.52, lng: 73.85, accuracy: 30 } }, { ip: '203.0.113.9', userAgent: IPHONE, referrer: 'https://example.com/' });
  assert.match(made.refNo, /^FP-\d{6}-[0-9A-F]{4}$/);
  assert.equal(made.totals.total, 157320);
  assert.equal(made.device, undefined);
  assert.equal(made.location, undefined);
  assert.equal((await getFreeProposal(made.token)).data.client.name, 'Ravi Kumar');
  await assert.rejects(() => getFreeProposal('nope-nope-nope'), /not found/);

  const [row] = await listFreeProposals();
  assert.deepEqual([row.companyName, row.contactName, row.email, row.clientName, row.logo], ['Sunrise Solar', 'Asha Rao', 'asha@example.com', 'Ravi Kumar', undefined]);
  assert.deepEqual([row.device.browser, row.device.os, row.device.type, row.device.screen], ['Safari', 'iOS', 'mobile', '390x844']);
  assert.deepEqual([row.location.ip, row.location.timezone, row.location.lat, row.location.lng], ['203.0.113.9', 'Asia/Kolkata', 18.52, 73.85]);
  assert.equal((await adminGetFreeProposal(row.id)).logo, LOGO);

  // the visitor changes a quantity and downloads: same proposal, new total, the shared position stays
  const edited = await updateFreeProposal(made.token, { ...body({ items: [{ name: 'Solar panels', qty: 10, rate: 15000 }], pricing: {} }), downloaded: true }, { ip: '203.0.113.10', userAgent: IPHONE });
  assert.deepEqual([edited.refNo, edited.totals.total], [made.refNo, 150000]);
  const after = await adminGetFreeProposal(row.id);
  assert.deepEqual([after.downloads, after.location.lat, after.location.ip], [1, 18.52, '203.0.113.10']);
  await assert.rejects(() => updateFreeProposal('nope-nope-nope', body()), /not found/);

  assert.equal(await countNewFreeProposals(), 1);
  const updated = await adminUpdateFreeProposal(row.id, { status: 'contacted', adminNotes: 'Called' });
  assert.deepEqual([updated.status, updated.adminNotes], ['contacted', 'Called']);
  assert.equal(await countNewFreeProposals(), 0);
  await assert.rejects(() => adminUpdateFreeProposal(row.id, { status: 'weird' }), /Unknown status/);
  await removeFreeProposal(row.id);
  assert.equal(await FreeProposal.countDocuments({}), 0);
});
