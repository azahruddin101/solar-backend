// Inventory for manual testing: more suppliers, new products in every category and several receipts (batches) per
// product, arranged so that every combination the stock screens, pickers and the sale chain can meet is present:
// serialized and per-batch products, one supplier or several, equal or different batch prices, FIFO across batches,
// partly and fully consumed batches, low stock, out of stock (no batch / all consumed), tiny and huge quantities,
// GST 0 / 5 / 12 / 18 / 28 %, every unit, manufacture date / year / neither, missing optional fields…
// Each product names its `scenario` so a tester knows what it is for. Seeded by seeders/inventory.seeder.js.

/** The seed's suppliers. The three showcase suppliers (Sunrise, Deccan, Shree Steel) are reused when they exist. */
export const INVENTORY_SUPPLIERS = [
  { name: 'Tata Power Solar Distributors Pune', phone: '9822233445', email: 'dealer.pune@tatapowersolar.in', gstNumber: '27AABCT3518Q1ZV', address: 'Plot 12, Hinjewadi Phase 2, Pune, Maharashtra 411057', notes: 'Authorised distributor. 30-day credit, delivery in 3 working days.', categories: ['Solar panels', 'Inverters'] },
  { name: 'Gujarat Renewables Trading Co', phone: '9898012345', email: 'sales@gujaratrenewables.com', gstNumber: '24AAFCG2911R1Z2', address: 'Shed 44, GIDC Vatva, Ahmedabad, Gujarat 382445', notes: 'Inter-state supplier (IGST). Panels and batteries at volume prices.', categories: ['Solar panels', 'Batteries & Energy Storage', 'Mounting Structure / Hardware'] },
  { name: 'Kalyani Hardware & Electricals', phone: '9922334455', email: '', gstNumber: '', address: 'Shop 7, Market Yard, Pune, Maharashtra 411037', notes: 'Unregistered dealer: cash purchases, no GST invoice, no email.', categories: ['Mounting Structure / Hardware', 'Accessories & Consumables', 'Wire & Cabling'] },
  { name: 'Bengaluru Power Components', phone: '9845098450', email: 'accounts@blrpower.in', gstNumber: '29AADCK7781P1ZX', address: '3rd Phase, Peenya Industrial Area, Bengaluru, Karnataka 560058', notes: 'Protection and metering. Ships by courier, 5–7 days.', categories: ['ACDB Box', 'DCDB Box', 'Metering & Monitoring', 'Chemical Earthing Kit'] },
  { name: 'Universal Cables Agency', phone: '9850098500', email: 'orders@universalcables.in', gstNumber: '27AAGFU5566L1Z8', address: '221, Tilak Road, Pune, Maharashtra 411030', notes: 'Sells across categories, so no category is set.', categories: [] },
  { name: 'Dormant Traders LLP', phone: '9876500001', email: 'hello@dormanttraders.in', gstNumber: '27AAJFD9988K1ZQ', address: 'Camp, Pune, Maharashtra 411001', notes: 'Added but never bought from: nothing received from this supplier.', categories: ['Poles / pillars'] },
];

/** Showcase suppliers, by name (created only when missing, e.g. on a company that never had the showcase catalog). */
export const SHOWCASE_SUPPLIER_FALLBACK = [
  { name: 'Sunrise Solar Distributors', phone: '9822077001', email: 'orders@sunrisesolar.in', gstNumber: '27AAGCS7712K1Z3', address: 'Bhosari MIDC, Pune 411026', categories: ['Solar panels', 'Inverters', 'Batteries & Energy Storage', 'Metering & Monitoring'] },
  { name: 'Deccan Electricals & Cables', phone: '9850012300', email: 'sales@deccanelectricals.in', gstNumber: '27AADFD4421L1Z9', address: 'Budhwar Peth, Pune 411002', categories: ['Wire & Cabling', 'Chemical Earthing Kit', 'ACDB Box', 'DCDB Box'] },
  { name: 'Shree Steel Structures', phone: '9763320045', email: 'info@shreesteel.in', gstNumber: '27ABKPS6623M1Z1', address: 'Chakan Industrial Area, Pune 410501', categories: ['Poles / pillars', 'Mounting Structure / Hardware'] },
];

const attrs = (...list) => list.map(([label, dataType = 'text', options = [], isRequired = false]) => ({ label, dataType, options, isRequired }));

/**
 * Categories the products below live in. Existing categories of the company are used as they are (matched by name);
 * a missing one is created with these attributes. "Accessories & Consumables" is new and brings a boolean attribute.
 */
export const INVENTORY_CATEGORIES = [
  { name: 'Solar panels', type: 'panels', description: 'Modules used in the designer and printed on proposals.', attributes: attrs(['Cell type', 'select', ['Mono PERC', 'Mono PERC half-cut', 'N-type TOPCon'], true], ['Efficiency (%)', 'number', [], true], ['Cell count', 'number'], ['Bifaciality']) },
  { name: 'Poles / pillars', type: 'poles', description: 'Mounting poles, priced per foot.', attributes: attrs(['Material'], ['Coating'], ['Thickness']) },
  { name: 'Inverters', description: 'On-grid, hybrid and micro string inverters.', attributes: attrs(['Capacity (kW)', 'number', [], true], ['MPPT count', 'number'], ['Phase', 'select', ['Single phase', 'Three phase'], true], ['Max efficiency (%)', 'number'], ['Wi-Fi']) },
  { name: 'Wire & Cabling', description: 'Solar DC cable and multi-core AC copper / aluminium cabling.', attributes: attrs(['Size (sq.mm)', 'number', [], true], ['Conductor'], ['Insulation'], ['Voltage rating']) },
  { name: 'Chemical Earthing Kit', description: 'Maintenance-free chemical earthing electrodes and compound.', attributes: attrs(['Electrode type'], ['Length (m)'], ['Diameter (mm)'], ['Backfill compound']) },
  { name: 'ACDB Box', description: 'AC distribution boxes with MCB / MCCB, SPD and energy-meter provisions.', attributes: attrs(['Rating (A)', 'number', [], true], ['Phases'], ['SPD class'], ['IP rating', 'select', ['IP65', 'IP66']]) },
  { name: 'DCDB Box', description: 'DC distribution boxes with fuses, SPD and a DC isolator.', attributes: attrs(['Inputs / outputs'], ['Fuse rating (A)', 'number'], ['SPD rating'], ['Enclosure']) },
  { name: 'Mounting Structure / Hardware', description: 'Rails, clamps, fasteners and brackets.', attributes: attrs(['Material'], ['Hardware grade'], ['Wind speed rating (km/h)']) },
  { name: 'Batteries & Energy Storage', description: 'LiFePO4 and lead-acid storage.', attributes: attrs(['Capacity (kWh)', 'number', [], true], ['Chemistry', 'select', ['LiFePO4', 'Lead-acid tubular'], true], ['Voltage (V)', 'number'], ['Cycle life']) },
  { name: 'Metering & Monitoring', description: 'Net meters, CTs and remote monitoring.', attributes: attrs(['Type'], ['Accuracy class'], ['Communication']) },
  { name: 'Accessories & Consumables', description: 'Connectors, glands, ties, compounds and cleaning gear.', attributes: attrs(['Pack size', 'number'], ['Colour', 'select', ['Black', 'Red', 'Grey', 'Transparent']], ['Outdoor rated', 'boolean'], ['Notes']) },
];

/* ───────────── products ───────────── */

// A receipt: who it came from, how many, the retail price (the other three prices follow unless given), when it was
// received (`days` ago), its manufacture date / year, an optional note, and `consumed` (quantity already gone, for
// per-batch products only — it lowers qtyRemaining to show FIFO picking up where it left off).
const batch = (supplier, qty, retail, days, extra = {}) => ({ supplier, qty, retail, days, ...extra });

const SUNRISE = 'Sunrise Solar Distributors';
const DECCAN = 'Deccan Electricals & Cables';
const SHREE = 'Shree Steel Structures';
const TATA = 'Tata Power Solar Distributors Pune';
const GUJARAT = 'Gujarat Renewables Trading Co';
const KALYANI = 'Kalyani Hardware & Electricals';
const BLR = 'Bengaluru Power Components';
const UNIVERSAL = 'Universal Cables Agency';

export const INVENTORY_PRODUCTS = [
  /* Solar panels — serialized, used by the designer (watts, size) */
  {
    category: 'Solar panels', scenario: 'Serialized · 3 batches from 3 suppliers at 3 prices · date / year / nothing',
    name: 'Waaree Elite bifacial WSMD-545 (545 Wp)', brand: 'Waaree', model: 'Elite WSMD-545 Bi', sku: 'PNL-WA-545B', hsnCode: '85414300', unit: 'Panel', gstPercent: 12, warrantyMonths: 300, reorderLevel: 20, isSerialized: true,
    watts: 545, length: 2.279, width: 1.134, description: '545 Wp bifacial half-cut module, 2.279 × 1.134 m, 30 mm frame.',
    attributes: { 'Cell type': 'Mono PERC half-cut', 'Efficiency (%)': '21.1', 'Cell count': '144', Bifaciality: 'Yes (70%)' },
    batches: [batch(SUNRISE, 40, 14400, 95, { mfgDate: 220, note: 'First lot, older production' }), batch(TATA, 40, 14100, 40, { mfgYear: 2026, note: 'Dealer price list Q3' }), batch(GUJARAT, 40, 14900, 6, { note: 'Latest lot, IGST purchase' })],
  },
  {
    category: 'Solar panels', scenario: 'Serialized · exactly one unit in stock',
    name: 'Adani Solar Elan TOPCon 590 (590 Wp)', brand: 'Adani Solar', model: 'Elan TOPCon 590', sku: 'PNL-AD-590', hsnCode: '85414300', unit: 'Panel', gstPercent: 12, warrantyMonths: 360, reorderLevel: 10, isSerialized: true,
    watts: 590, length: 2.278, width: 1.134, description: 'N-type TOPCon 590 Wp module, sample unit.',
    attributes: { 'Cell type': 'N-type TOPCon', 'Efficiency (%)': '22.8', 'Cell count': '144', Bifaciality: 'Yes (80%)' },
    batches: [batch(TATA, 1, 17400, 12, { mfgDate: 60, note: 'Sample piece for the demo roof' })],
  },
  {
    category: 'Solar panels', scenario: 'Serialized · out of stock (never received)',
    name: 'ReNew Sunrise mono 550 (550 Wp)', brand: 'ReNew', model: 'Sunrise M550', sku: 'PNL-RN-550', hsnCode: '85414300', unit: 'Panel', gstPercent: 12, warrantyMonths: 300, reorderLevel: 10, isSerialized: true,
    watts: 550, length: 2.278, width: 1.134, description: 'Listed in the catalog but nothing received yet.',
    attributes: { 'Cell type': 'Mono PERC half-cut', 'Efficiency (%)': '21.3', 'Cell count': '144', Bifaciality: 'No' },
    batches: [],
  },
  {
    category: 'Solar panels', scenario: 'Serialized · one big batch of 150 units (unit list paging) · serial numbers with slashes',
    name: 'Goldi Solar HELOC Pro 575 (575 Wp)', brand: 'Goldi Solar', model: 'HELOC Pro 575', sku: 'PNL-GD-575', hsnCode: '85414300', unit: 'Panel', gstPercent: 12, warrantyMonths: 300, reorderLevel: 30, isSerialized: true,
    watts: 575, length: 2.278, width: 1.134, description: 'Bulk purchase for the Mehta Textiles shed.',
    attributes: { 'Cell type': 'N-type TOPCon', 'Efficiency (%)': '22.3', 'Cell count': '144', Bifaciality: 'Yes (70%)' },
    serialFormat: (n) => `GS/575/26/${String(n).padStart(4, '0')}`,
    batches: [batch(GUJARAT, 150, 16200, 18, { mfgYear: 2026, note: 'Container lot, 150 pcs' })],
  },

  /* Inverters — serialized category; one non-serialized accessory lives here too */
  {
    category: 'Inverters', scenario: 'Serialized · 2 batches, 2 suppliers, the SAME price (no split warning)',
    name: 'Growatt MOD 6000TL3-X three-phase inverter', brand: 'Growatt', model: 'MOD 6000TL3-X', sku: 'INV-GW-6K3', hsnCode: '85044090', unit: 'Piece', gstPercent: 18, warrantyMonths: 60, reorderLevel: 3, isSerialized: true,
    description: '6 kW three-phase string inverter, 2 MPPT, built-in Wi-Fi.',
    attributes: { 'Capacity (kW)': '6.0', 'MPPT count': '2', Phase: 'Three phase', 'Max efficiency (%)': '98.4', 'Wi-Fi': 'Built-in' },
    batches: [batch(SUNRISE, 6, 54000, 70, { mfgYear: 2025 }), batch(TATA, 6, 54000, 9, { mfgYear: 2026 })],
  },
  {
    category: 'Inverters', scenario: 'Serialized · LOW stock (2 left, reorder level 5) · 2 batches at different prices',
    name: 'Luminous NXi 3 kW hybrid inverter', brand: 'Luminous', model: 'NXi 3000', sku: 'INV-LU-3KH', hsnCode: '85044090', unit: 'Piece', gstPercent: 18, warrantyMonths: 24, reorderLevel: 5, isSerialized: true,
    description: '3 kW single-phase hybrid inverter with battery port.',
    attributes: { 'Capacity (kW)': '3.0', 'MPPT count': '1', Phase: 'Single phase', 'Max efficiency (%)': '97.2', 'Wi-Fi': 'Optional dongle' },
    batches: [batch(SUNRISE, 1, 41000, 50, { mfgDate: 120 }), batch(UNIVERSAL, 1, 43500, 4, { note: 'Urgent single piece at a higher price' })],
  },
  {
    category: 'Inverters', scenario: 'NOT serialized although the category is · one batch',
    name: 'Growatt ShineWiFi-X monitoring dongle', brand: 'Growatt', model: 'ShineWiFi-X', sku: 'INV-GW-WIFI', hsnCode: '85176290', unit: 'Piece', gstPercent: 18, warrantyMonths: 12, reorderLevel: 5, isSerialized: false,
    description: 'Plug-in Wi-Fi logger for Growatt inverters.',
    attributes: { 'Capacity (kW)': '0', 'MPPT count': '0', Phase: 'Single phase', 'Max efficiency (%)': '0', 'Wi-Fi': 'Is the dongle' },
    batches: [batch(TATA, 25, 3200, 15, { mfgYear: 2026 })],
  },

  /* Batteries — serialized; lithium at 18 %, lead-acid at 28 % GST */
  {
    category: 'Batteries & Energy Storage', scenario: 'Serialized · 2 batches, different prices · GST 18 %',
    name: 'Okaya 7.5 kWh LiFePO4 wall battery', brand: 'Okaya', model: 'LFP-7.5W', sku: 'BAT-OK-7K', hsnCode: '85076000', unit: 'Piece', gstPercent: 18, warrantyMonths: 60, reorderLevel: 2, isSerialized: true,
    description: 'Wall-mounted 51.2 V LiFePO4 pack with BMS and CAN/RS485.',
    attributes: { 'Capacity (kWh)': '7.68', Chemistry: 'LiFePO4', 'Voltage (V)': '51.2', 'Cycle life': '6000 @ 80% DoD' },
    batches: [batch(GUJARAT, 4, 182000, 45, { mfgDate: 100 }), batch(SUNRISE, 4, 176500, 8, { mfgDate: 30, note: 'Price drop' })],
  },
  {
    category: 'Batteries & Energy Storage', scenario: 'Serialized · GST 28 % (lead-acid) · 36-month warranty',
    name: 'Amaron Quanta 12 V 200 Ah tubular battery', brand: 'Amaron', model: 'Quanta 12AL200', sku: 'BAT-AM-200', hsnCode: '85072000', unit: 'Piece', gstPercent: 28, warrantyMonths: 36, reorderLevel: 4, isSerialized: true,
    description: 'Tall tubular lead-acid battery for off-grid banks.',
    attributes: { 'Capacity (kWh)': '2.4', Chemistry: 'Lead-acid tubular', 'Voltage (V)': '12', 'Cycle life': '1200 @ 80% DoD' },
    batches: [batch(SUNRISE, 10, 21500, 22, { mfgDate: 40 })],
  },

  /* Wire & Cabling — per batch; FIFO, consumed batches, huge quantities, same-name products from two brands */
  {
    category: 'Wire & Cabling', scenario: 'Per batch · 2 batches, the older one PARTLY consumed (FIFO continues from it) · same spec as the Havells cable (name matching)',
    name: 'Polycab 4-core 10 sq.mm armoured AC cable', brand: 'Polycab', model: '4C 10 Al armoured', sku: 'CAB-PC-AC10', hsnCode: '8544', unit: 'Metre', gstPercent: 18, warrantyMonths: 120, reorderLevel: 100,
    description: 'Aluminium armoured 4-core cable, 1100 V.',
    attributes: { 'Size (sq.mm)': '10', Conductor: 'Aluminium', Insulation: 'XLPE', 'Voltage rating': '1100 V AC' },
    batches: [batch(DECCAN, 500, 165, 80, { mfgYear: 2025, consumed: 300, note: '300 m already issued to earlier jobs' }), batch(UNIVERSAL, 500, 172, 10, { mfgYear: 2026 })],
  },
  {
    category: 'Wire & Cabling', scenario: 'Per batch · 4 batches, the SAME price, dates spread over 4 months',
    name: 'KEI solar DC cable 4 sq.mm (500 m drum)', brand: 'KEI', model: 'Solar DC 4 drum', sku: 'CAB-KEI-DC4', hsnCode: '8544', unit: 'Roll', gstPercent: 18, warrantyMonths: 120, reorderLevel: 5,
    description: 'Tinned copper, XLPO, 1500 V DC; 500 m wooden drum.',
    attributes: { 'Size (sq.mm)': '4', Conductor: 'Tinned copper, class 5', Insulation: 'XLPO', 'Voltage rating': '1500 V DC' },
    batches: [batch(DECCAN, 10, 21000, 120, { mfgYear: 2025 }), batch(DECCAN, 10, 21000, 90), batch(UNIVERSAL, 10, 21000, 45, { mfgYear: 2026 }), batch(KALYANI, 10, 21000, 5, { note: 'Cash purchase, no GST invoice' })],
  },
  {
    category: 'Wire & Cabling', scenario: 'Per batch · first batch FULLY consumed (hidden from in-stock pickers), second live',
    name: 'Finolex earthing wire 6 sq.mm green (90 m coil)', brand: 'Finolex', model: 'FR 6 green', sku: 'CAB-FX-E6', hsnCode: '8544', unit: 'Bundle', gstPercent: 18, warrantyMonths: 0, reorderLevel: 4,
    description: 'Single-core green/yellow earthing conductor.',
    attributes: { 'Size (sq.mm)': '6', Conductor: 'Copper', Insulation: 'PVC FR', 'Voltage rating': '1100 V' },
    batches: [batch(DECCAN, 20, 2100, 100, { consumed: 20, note: 'All used up' }), batch(DECCAN, 12, 2250, 14)],
  },
  {
    category: 'Wire & Cabling', scenario: 'Per batch · OUT of stock because every batch is consumed',
    name: 'RR Kabel 1.5 sq.mm FR wire (90 m coil)', brand: 'RR Kabel', model: 'Superex FR 1.5', sku: 'CAB-RR-15', hsnCode: '8544', unit: 'Bundle', gstPercent: 18, warrantyMonths: 0, reorderLevel: 10,
    description: 'House wiring, red.',
    attributes: { 'Size (sq.mm)': '1.5', Conductor: 'Copper', Insulation: 'PVC FR', 'Voltage rating': '1100 V' },
    batches: [batch(DECCAN, 30, 1450, 150, { consumed: 30 }), batch(KALYANI, 10, 1500, 60, { consumed: 10 })],
  },
  {
    category: 'Wire & Cabling', scenario: 'Per batch · HUGE quantity (50,000 m) · purchase price left blank',
    name: 'Havells 2-core 2.5 sq.mm flexible cable', brand: 'Havells', model: '2C 2.5 flex', sku: 'CAB-HV-F25', hsnCode: '8544', unit: 'Metre', gstPercent: 18, warrantyMonths: 0, reorderLevel: 2000,
    description: 'Flexible copper cable sold per metre from a 1 km drum rack.',
    attributes: { 'Size (sq.mm)': '2.5', Conductor: 'Copper, class 5', Insulation: 'PVC', 'Voltage rating': '1100 V' },
    batches: [batch(UNIVERSAL, 50000, 42, 30, { prices: { purchasePrice: null }, mfgYear: 2026 })],
  },

  /* Earthing, ACDB, DCDB, metering — per batch */
  {
    category: 'Chemical Earthing Kit', scenario: 'Per batch · 3 suppliers, 3 prices (one line per batch on documents)',
    name: 'Ashlok copper-bonded electrode 2 m with compound', brand: 'Ashlok', model: 'Safe-Earth 50/2', sku: 'ERT-AS-2M', hsnCode: '8536', unit: 'Set', gstPercent: 18, warrantyMonths: 120, reorderLevel: 6,
    description: 'Shorter 2 m electrode for rocky sites.',
    attributes: { 'Electrode type': 'Copper bonded steel', 'Length (m)': '2.0', 'Diameter (mm)': '50', 'Backfill compound': '15 kg included' },
    batches: [batch(DECCAN, 8, 3600, 75, { mfgYear: 2025 }), batch(BLR, 8, 3450, 35), batch(KALYANI, 8, 3800, 3)],
  },
  {
    category: 'ACDB Box', scenario: 'Per batch · 2 batches · IP66 select value',
    name: 'Siemens single-phase 32 A ACDB', brand: 'Siemens', model: 'Betagard 32A-2P', sku: 'ACDB-SI-32', hsnCode: '8537', unit: 'Piece', gstPercent: 18, warrantyMonths: 60, reorderLevel: 3,
    description: 'MCB + SPD + metering provision, IP66.',
    attributes: { 'Rating (A)': '32', Phases: 'Single phase', 'SPD class': 'Type 2', 'IP rating': 'IP66' },
    batches: [batch(BLR, 12, 3950, 40), batch(DECCAN, 12, 4100, 6)],
  },
  {
    category: 'DCDB Box', scenario: 'Per batch · single batch · new brand',
    name: 'Elmex 3-in 1-out 1000 V DCDB', brand: 'Elmex', model: 'PV 3-1', sku: 'DCDB-EL-31', hsnCode: '8537', unit: 'Piece', gstPercent: 18, warrantyMonths: 60, reorderLevel: 3,
    description: 'Three strings in, one out, with fuses and SPD.',
    attributes: { 'Inputs / outputs': '3 in / 1 out', 'Fuse rating (A)': '15', 'SPD rating': '1000 V DC Type 2', Enclosure: 'IP65 polycarbonate' },
    batches: [batch(BLR, 15, 6400, 20, { mfgYear: 2026 })],
  },
  {
    category: 'Metering & Monitoring', scenario: 'Per batch · 2 batches · whole-current meter',
    name: 'L&T bi-directional net meter (three phase, whole current)', brand: 'L&T', model: 'WM3P-WC', sku: 'MTR-LT-3PW', hsnCode: '9028', unit: 'Piece', gstPercent: 18, warrantyMonths: 60, reorderLevel: 4,
    description: 'Three-phase whole-current net meter, class 1.0.',
    attributes: { Type: 'Bi-directional', 'Accuracy class': '1.0', Communication: 'RS485 / IR' },
    batches: [batch(BLR, 10, 7200, 55), batch(SUNRISE, 10, 7450, 7)],
  },

  /* Mounting — per batch; and a pole */
  {
    category: 'Mounting Structure / Hardware', scenario: 'Per batch · 3 batches at 3 prices · sold by the box',
    name: 'Anchor fastener M10 × 100 (box of 50)', brand: 'Hilti', model: 'HSA M10x100', sku: 'MMS-HL-M10', hsnCode: '7318', unit: 'Box', gstPercent: 18, warrantyMonths: 0, reorderLevel: 5,
    description: 'Expansion anchors for pedestal fixing.',
    attributes: { Material: 'Zinc-plated steel', 'Hardware grade': '8.8', 'Wind speed rating (km/h)': '—' },
    batches: [batch(SHREE, 20, 1850, 90), batch(KALYANI, 15, 1700, 30, { note: 'Cash purchase' }), batch(GUJARAT, 10, 1990, 2)],
  },
  {
    category: 'Poles / pillars', scenario: 'Per batch · pole priced per foot · 2 batches, different prices',
    name: 'GI rectangular tube 80×40', brand: 'Apollo', model: '', sku: 'POLE-GIRT8040', hsnCode: '7308', unit: 'Foot', gstPercent: 18, warrantyMonths: 120, reorderLevel: 300, shape: 'square',
    description: 'Hot-dip galvanised rectangular section for elevated structures.',
    attributes: { Material: 'Galvanised iron', Coating: 'Hot-dip zinc', Thickness: '2.9 mm' },
    batches: [batch(SHREE, 1500, 180, 60, { mfgYear: 2025 }), batch(SHREE, 1000, 192, 8)],
  },

  /* Accessories & Consumables — the new category; text / number / select / boolean attributes */
  {
    category: 'Accessories & Consumables', scenario: 'Per batch · 3 batches, one partly consumed · sold in Nos',
    name: 'Stäubli MC4 connector pair', brand: 'Stäubli', model: 'MC4-Evo 2', sku: 'ACC-ST-MC4', hsnCode: '85366990', unit: 'Nos', gstPercent: 18, warrantyMonths: 0, reorderLevel: 50,
    description: 'Male + female pair, 4–6 sq.mm, 1500 V.',
    attributes: { 'Pack size': '1', Colour: 'Black', 'Outdoor rated': 'yes', Notes: 'Original Stäubli, not clones' },
    batches: [batch(KALYANI, 200, 95, 110, { consumed: 140 }), batch(UNIVERSAL, 200, 98, 40), batch(DECCAN, 100, 92, 5)],
  },
  {
    category: 'Accessories & Consumables', scenario: 'Per batch · 2 batches · sold by the Lot',
    name: 'UV-resistant cable ties 300 mm (pack of 100)', brand: 'HellermannTyton', model: 'T50L UV', sku: 'ACC-HT-CT300', hsnCode: '39269099', unit: 'Lot', gstPercent: 18, warrantyMonths: 0, reorderLevel: 10,
    description: 'Black UV-stabilised nylon ties.',
    attributes: { 'Pack size': '100', Colour: 'Black', 'Outdoor rated': 'yes', Notes: '' },
    batches: [batch(KALYANI, 30, 240, 35), batch(KALYANI, 30, 255, 4)],
  },
  {
    category: 'Accessories & Consumables', scenario: 'Per batch · GST 5 % · sold per Kg · no warranty',
    name: 'Earthing backfill compound', brand: 'Ashlok', model: 'Earth-Rich', sku: 'ACC-AS-BFC', hsnCode: '25309099', unit: 'Kg', gstPercent: 5, warrantyMonths: 0, reorderLevel: 50,
    description: 'Bentonite-based conductive backfill, sold loose per kg from 25 kg bags.',
    attributes: { 'Pack size': '25', Colour: 'Grey', 'Outdoor rated': 'no', Notes: 'Keep dry' },
    batches: [batch(DECCAN, 500, 38, 25, { mfgYear: 2026 })],
  },
  {
    category: 'Accessories & Consumables', scenario: 'Per batch · OUT of stock (never received) · reorder level set',
    name: 'Cable gland PG13.5 brass', brand: 'Comet', model: 'PG13.5-BR', sku: 'ACC-CM-PG13', hsnCode: '74153900', unit: 'Nos', gstPercent: 18, warrantyMonths: 0, reorderLevel: 50,
    description: 'Nickel-plated brass gland with PVC washer.',
    attributes: { 'Pack size': '1', Colour: 'Grey', 'Outdoor rated': 'yes', Notes: '' },
    batches: [],
  },
  {
    category: 'Accessories & Consumables', scenario: 'Per batch · GST 12 % · NO brand, model or SKU',
    name: 'Panel cleaning kit (brush + 6 m pole)', brand: '', model: '', sku: '', hsnCode: '96039000', unit: 'Set', gstPercent: 12, warrantyMonths: 6, reorderLevel: 2,
    description: 'Soft brush head with water feed and telescopic pole.',
    attributes: { 'Pack size': '1', Colour: 'Transparent', 'Outdoor rated': 'yes', Notes: 'Generic import' },
    batches: [batch(KALYANI, 8, 2900, 16)],
  },
  {
    category: 'Accessories & Consumables', scenario: 'Per batch · GST 0 % · one batch',
    name: 'Printed warranty & handover booklet', brand: '', model: '', sku: 'ACC-DOC-WB', hsnCode: '49019900', unit: 'Nos', gstPercent: 0, warrantyMonths: 0, reorderLevel: 20,
    description: 'Client handover booklet (printed matter, nil GST).',
    attributes: { 'Pack size': '1', Colour: 'Transparent', 'Outdoor rated': 'no', Notes: '' },
    batches: [batch(KALYANI, 100, 60, 12)],
  },
];

/**
 * Extra receipts for products the company already had (the showcase catalog): two more batches each, from a supplier
 * other than the one they came from — an OLDER one at a lower price (FIFO picks it first) and a NEWER one at a higher
 * price. Quantities are a share of what the product already had. Batch numbers end in -S1 / -S2 so the seed can tell
 * them apart and never adds them twice.
 */
export const EXTRA_BATCHES_FOR_EXISTING = [
  { suffix: 'S1', days: 130, priceFactor: 0.94, share: 0.15, mfgDate: 210, note: 'Early stock from a second supplier' },
  { suffix: 'S2', days: 4, priceFactor: 1.05, share: 0.1, mfgYear: new Date().getFullYear(), note: 'Latest purchase, price went up' },
];

/** Which seed supplier supplies which category when a second source is needed. */
export const SECOND_SOURCE = {
  'Solar panels': [TATA, GUJARAT],
  Inverters: [TATA, UNIVERSAL],
  'Batteries & Energy Storage': [GUJARAT, SUNRISE],
  'Wire & Cabling': [UNIVERSAL, KALYANI],
  'Chemical Earthing Kit': [BLR, KALYANI],
  'ACDB Box': [BLR, UNIVERSAL],
  'DCDB Box': [BLR, UNIVERSAL],
  'Mounting Structure / Hardware': [KALYANI, GUJARAT],
  'Metering & Monitoring': [BLR, UNIVERSAL],
  'Poles / pillars': [KALYANI, UNIVERSAL],
  'Accessories & Consumables': [KALYANI, UNIVERSAL],
};
