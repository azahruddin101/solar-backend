// One fully populated demo company: profile, team, clients, a real-looking catalog (several products in every
// category), packages that reference those products, designs and installations. Every value follows the app's
// own validation rules (10-digit mobiles, PAN / GSTIN formats, …).
import { lShape, rect, site } from './companies.js';

export const SHOWCASE_LOGIN = { email: 'demo@suryashakti.in', name: 'Rajesh Kulkarni' };

export const SHOWCASE_COMPANY = {
  name: 'Surya Shakti Energy Solutions Pvt Ltd',
  email: 'info@suryashakti.in',
  phone: '9822012345',
  address: 'Office 302, Kumar Business Centre, Baner Road, Pune, Maharashtra 411045',
  website: 'www.suryashakti.in',
  taxId: '27AAKCS4821M1Z5',
  pan: 'AAKCS4821M',
  theme: { primary: '#0b6e4f', accent: '#f4a300' },
  signatoryName: 'Rajesh Kulkarni',
  signatoryTitle: 'Managing Director',
  qrLabel: 'Scan to visit suryashakti.in',
  tagline: 'Every roof, a power plant',
  currency: 'INR',
  tariff: 9.2,
  otherCostPerKw: 17500,
  notes: 'Showcase company for demos.',
  productUnits: ['piece', 'nos', 'set', 'metre', 'foot', 'kg', 'box', 'roll', 'lot', 'bundle', 'panel'],
  pdfTerms: [
    '<h3>Validity &amp; payment</h3>',
    '<ol><li>This proposal is valid for <strong>30 days</strong> from the date of issue.</li>',
    '<li>Payment: <strong>40%</strong> advance with the order, <strong>50%</strong> on material delivery, <strong>10%</strong> after commissioning.</li>',
    '<li>Prices include <strong>GST</strong> and standard installation up to a 20 m cable run.</li></ol>',
    '<h3>Approvals &amp; warranty</h3>',
    '<ul><li>Net-metering approval by <strong>MSEDCL</strong> is handled by us; DISCOM charges are extra.</li>',
    '<li>Panels: manufacturer product warranty (25–30 years) and linear performance warranty.</li>',
    '<li>Our installation workmanship is covered for <strong>5 years</strong>.</li></ul>',
  ].join(''),
};

/** roles are labels from the company's agent-role list */
export const SHOWCASE_AGENTS = [
  { name: 'Sandeep Patil', email: 'sandeep.patil@suryashakti.in', phone: '9822154321', roles: ['Site surveyor', 'Inspector'] },
  { name: 'Imran Shaikh', email: 'imran.shaikh@suryashakti.in', phone: '9822198765', roles: ['Electrician', 'Installer'] },
  { name: 'Ganesh Jadhav', email: 'ganesh.jadhav@suryashakti.in', phone: '9890123456', roles: ['Installer'] },
  { name: 'Sneha Kulkarni', email: 'sneha.kulkarni@suryashakti.in', phone: '9765432109', roles: ['Supervisor', 'Inspector'] },
  { name: 'Amol Deshpande', email: 'amol.deshpande@suryashakti.in', phone: '9850667788', roles: ['Electrician'] },
  { name: 'Farah Sayyed', email: 'farah.sayyed@suryashakti.in', phone: '7038112233', roles: ['Site surveyor'] },
];

/* ───────────── catalog ───────────── */

const specs = (keys, values) => keys.map((key, i) => ({ key, value: values[i] ?? '' }));

export const SHOWCASE_CATEGORIES = [
  {
    name: 'Solar panels',
    type: 'panels',
    description: 'Modules used in the designer and printed on proposals.',
    specKeys: ['Cell type', 'Efficiency (%)', 'Cell count', 'Bifaciality'],
    products: [
      { brand: 'Waaree', model: 'Ahnay WSMD-540', watts: 540, length: 2.278, width: 1.134, year: 2026, warranty: 25, price: 13900, sku: 'PNL-WA-540', values: ['Mono PERC half-cut', '20.9', '144', 'No'] },
      { brand: 'Tata Power Solar', model: 'TP440M-BF', watts: 440, length: 2.094, width: 1.038, year: 2025, warranty: 25, price: 11400, sku: 'PNL-TP-440', values: ['Mono PERC half-cut', '20.2', '108', 'No'] },
      { brand: 'Adani Solar', model: 'Shine TOPCon 575', watts: 575, length: 2.278, width: 1.134, year: 2026, warranty: 30, price: 16900, sku: 'PNL-AD-575', values: ['N-type TOPCon', '22.3', '144', 'Yes (70%)'] },
      { brand: 'Vikram Solar', model: 'Somera VSM.72.400', watts: 400, length: 1.976, width: 0.992, year: 2024, warranty: 27, price: 9800, sku: 'PNL-VK-400', values: ['Mono PERC', '20.4', '144', 'No'] },
      { brand: 'Premier Energies', model: 'PE-TOPCon 620', watts: 620, length: 2.382, width: 1.134, year: 2026, warranty: 30, price: 18700, sku: 'PNL-PE-620', values: ['N-type TOPCon', '22.9', '156', 'Yes (75%)'] },
    ].map((p) => ({ name: `${p.brand} ${p.model} (${p.watts} Wp)`, brand: p.brand, model: p.model, sku: p.sku, hsnCode: '85414300', unit: 'panel', price: p.price, warrantyYears: p.warranty, watts: p.watts, length: p.length, width: p.width, manufactureYear: p.year, quantity: 120, description: `${p.watts} Wp module, ${p.length} × ${p.width} m.`, specs: specs(['Cell type', 'Efficiency (%)', 'Cell count', 'Bifaciality'], p.values) })),
  },
  {
    name: 'Poles / pillars',
    type: 'poles',
    description: 'Mounting poles, priced per foot.',
    specKeys: ['Material', 'Coating', 'Thickness'],
    products: [
      { name: 'MS angle 50×50×5', shape: 'l-shape', price: 95, values: ['Mild steel', 'Red oxide primer + paint', '5 mm'] },
      { name: 'GI round pipe 2" (medium class)', shape: 'cylindrical', price: 140, values: ['Galvanised iron', 'Hot-dip zinc', '3.65 mm'] },
      { name: 'GI square tube 60×60', shape: 'square', price: 165, values: ['Galvanised iron', 'Hot-dip zinc', '3 mm'] },
      { name: 'HDG C-channel 41×41', shape: 'square', price: 150, values: ['Hot-dip galvanised steel', '80 micron zinc', '2.5 mm'] },
    ].map((p) => ({ name: p.name, brand: 'Jindal', model: '', sku: `POLE-${p.name.replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase()}`, hsnCode: '7308', unit: 'foot', price: p.price, shape: p.shape, warrantyYears: 10, quantity: 2000, specs: specs(['Material', 'Coating', 'Thickness'], p.values) })),
  },
  {
    name: 'Inverters',
    description: 'On-grid, hybrid and micro string inverters.',
    specKeys: ['Capacity (kW)', 'MPPT count', 'Phase', 'Max efficiency (%)', 'Wi-Fi'],
    products: [
      { name: 'Havells 3.3 kW single-phase on-grid inverter', brand: 'Havells', model: 'Enviro GT 3300', sku: 'INV-HV-3K', price: 36000, warranty: 7, values: ['3.3', '1', 'Single phase', '97.6', 'Optional dongle'] },
      { name: 'Growatt MIN 5000TL-X on-grid inverter', brand: 'Growatt', model: 'MIN 5000TL-X', sku: 'INV-GW-5K', price: 48000, warranty: 5, values: ['5.0', '2', 'Single phase', '98.4', 'Built-in'] },
      { name: 'Solis 8 kW three-phase on-grid inverter', brand: 'Solis', model: 'S5-GC8K', sku: 'INV-SL-8K', price: 71000, warranty: 5, values: ['8.0', '2', 'Three phase', '98.3', 'Built-in'] },
      { name: 'Sungrow SG10RT three-phase inverter', brand: 'Sungrow', model: 'SG10RT', sku: 'INV-SG-10K', price: 88000, warranty: 10, values: ['10.0', '2', 'Three phase', '98.5', 'iSolarCloud'] },
      { name: 'Sungrow SG25CX 25 kW commercial inverter', brand: 'Sungrow', model: 'SG25CX-P2', sku: 'INV-SG-25K', price: 168000, warranty: 10, values: ['25.0', '3', 'Three phase', '98.7', 'iSolarCloud'] },
    ].map((p) => ({ ...p, hsnCode: '85044090', unit: 'piece', warrantyYears: p.warranty, quantity: 15, specs: specs(['Capacity (kW)', 'MPPT count', 'Phase', 'Max efficiency (%)', 'Wi-Fi'], p.values) })),
  },
  {
    name: 'Wire & Cabling',
    description: 'Solar DC cable and multi-core AC copper / aluminium cabling.',
    specKeys: ['Size (sq.mm)', 'Conductor', 'Insulation', 'Voltage rating'],
    products: [
      { name: 'Polycab solar DC cable 4 sq.mm (100 m roll)', brand: 'Polycab', model: 'Solar DC 4', sku: 'CAB-DC-4', price: 4500, unit: 'roll', values: ['4', 'Tinned copper, class 5', 'XLPO', '1500 V DC'] },
      { name: 'Polycab solar DC cable 6 sq.mm (100 m roll)', brand: 'Polycab', model: 'Solar DC 6', sku: 'CAB-DC-6', price: 6400, unit: 'roll', values: ['6', 'Tinned copper, class 5', 'XLPO', '1500 V DC'] },
      { name: 'Havells 4-core 10 sq.mm armoured AC cable', brand: 'Havells', model: '4C 10 Al armoured', sku: 'CAB-AC-10', price: 170, unit: 'metre', values: ['10', 'Aluminium', 'XLPE', '1100 V AC'] },
      { name: 'Havells 4-core 16 sq.mm armoured AC cable', brand: 'Havells', model: '4C 16 Al armoured', sku: 'CAB-AC-16', price: 245, unit: 'metre', values: ['16', 'Aluminium', 'XLPE', '1100 V AC'] },
    ].map((p) => ({ ...p, hsnCode: '8544', warrantyYears: 10, quantity: 40, specs: specs(['Size (sq.mm)', 'Conductor', 'Insulation', 'Voltage rating'], p.values) })),
  },
  {
    name: 'Chemical Earthing Kit',
    description: 'Maintenance-free chemical earthing electrodes and compound.',
    specKeys: ['Electrode type', 'Length (m)', 'Diameter (mm)', 'Backfill compound'],
    products: [
      { name: 'Copper-bonded earthing electrode 3 m with compound', brand: 'Ashlok', model: 'Safe-Earth 50', sku: 'ERT-AS-3M', price: 4200, values: ['Copper bonded steel', '3.0', '50', '25 kg included'] },
      { name: 'GI pipe chemical earthing kit 3 m', brand: 'Kalinga', model: 'GI-EK-3', sku: 'ERT-KL-3M', price: 2650, values: ['GI pipe', '3.0', '50', '25 kg included'] },
      { name: 'Copper plate earthing set 600×600', brand: 'Ashlok', model: 'CP-600', sku: 'ERT-AS-CP', price: 5900, values: ['Copper plate', '—', '600 × 600 × 3', '30 kg included'] },
    ].map((p) => ({ ...p, hsnCode: '8536', unit: 'set', warrantyYears: 10, quantity: 30, specs: specs(['Electrode type', 'Length (m)', 'Diameter (mm)', 'Backfill compound'], p.values) })),
  },
  {
    name: 'ACDB Box',
    description: 'AC distribution boxes with MCB / MCCB, SPD and energy-meter provisions.',
    specKeys: ['Rating (A)', 'Phases', 'SPD class', 'IP rating'],
    products: [
      { name: 'L&T single-phase 25 A ACDB', brand: 'L&T', model: 'Exora 25A-2P', sku: 'ACDB-LT-25', price: 3400, values: ['25', 'Single phase', 'Type 2', 'IP65'] },
      { name: 'Schneider Acti9 three-phase 32 A ACDB', brand: 'Schneider Electric', model: 'Acti9 32A-4P', sku: 'ACDB-SE-32', price: 6800, values: ['32', 'Three phase + N', 'Type 2', 'IP65'] },
      { name: 'Havells three-phase 63 A ACDB with MCCB', brand: 'Havells', model: 'MCCB 63A-4P', sku: 'ACDB-HV-63', price: 11800, values: ['63', 'Three phase + N', 'Type 2', 'IP66'] },
    ].map((p) => ({ ...p, hsnCode: '8537', unit: 'piece', warrantyYears: 5, quantity: 25, specs: specs(['Rating (A)', 'Phases', 'SPD class', 'IP rating'], p.values) })),
  },
  {
    name: 'DCDB Box',
    description: 'DC distribution boxes with fuses, SPD and a DC isolator.',
    specKeys: ['Inputs / outputs', 'Fuse rating (A)', 'SPD rating', 'Enclosure'],
    products: [
      { name: 'Hensel 1-in 1-out 1000 V DCDB', brand: 'Hensel', model: 'PV 1-1', sku: 'DCDB-HN-11', price: 3900, values: ['1 in / 1 out', '15', '1000 V DC Type 2', 'IP65 polycarbonate'] },
      { name: 'Hensel 2-in 2-out 1000 V DCDB', brand: 'Hensel', model: 'PV 2-2', sku: 'DCDB-HN-22', price: 5600, values: ['2 in / 2 out', '15', '1000 V DC Type 2', 'IP65 polycarbonate'] },
      { name: 'Havells 4-in 2-out 1000 V DCDB', brand: 'Havells', model: 'PV 4-2', sku: 'DCDB-HV-42', price: 9400, values: ['4 in / 2 out', '20', '1000 V DC Type 2', 'IP65 metal'] },
    ].map((p) => ({ ...p, hsnCode: '8537', unit: 'piece', warrantyYears: 5, quantity: 25, specs: specs(['Inputs / outputs', 'Fuse rating (A)', 'SPD rating', 'Enclosure'], p.values) })),
  },
  {
    name: 'Mounting Structure / Hardware',
    description: 'Rails, clamps, fasteners and brackets.',
    specKeys: ['Material', 'Hardware grade', 'Wind speed rating (km/h)'],
    products: [
      { name: 'Aluminium rail & clamp kit (per kW)', brand: 'Pennar', model: 'AL-4100', sku: 'MMS-AL-KW', price: 3200, unit: 'set', values: ['Aluminium 6063-T6 anodised', 'SS 304', '170'] },
      { name: 'GI mounting structure (per kW)', brand: 'Pennar', model: 'GI-HDG-KW', sku: 'MMS-GI-KW', price: 2600, unit: 'set', values: ['Hot-dip galvanised steel', 'SS 304', '150'] },
      { name: 'SS 304 nut-bolt & anchor fastener pack', brand: 'Fischer', model: 'FP-100', sku: 'MMS-FP-100', price: 850, unit: 'box', values: ['Stainless steel 304', 'A2-70', '—'] },
    ].map((p) => ({ ...p, hsnCode: '7616', warrantyYears: 10, quantity: 60, specs: specs(['Material', 'Hardware grade', 'Wind speed rating (km/h)'], p.values) })),
  },
  {
    name: 'Batteries & Energy Storage',
    description: 'LiFePO4 and lead-acid storage.',
    specKeys: ['Capacity (kWh)', 'Chemistry', 'Voltage (V)', 'Cycle life'],
    products: [
      { name: 'Luminous 5.12 kWh LiFePO4 battery', brand: 'Luminous', model: 'LFP 51.2V 100Ah', sku: 'BAT-LU-5K', price: 135000, values: ['5.12', 'LiFePO4', '51.2', '6000 @ 80% DoD'] },
      { name: 'Exide 12 V 150 Ah solar tubular battery', brand: 'Exide', model: 'Solar 12-150', sku: 'BAT-EX-150', price: 16800, values: ['1.8', 'Lead-acid tubular', '12', '1500 @ 80% DoD'] },
      { name: 'Livguard 10 kWh LiFePO4 rack battery', brand: 'Livguard', model: 'LFP-10K', sku: 'BAT-LG-10K', price: 245000, values: ['10.24', 'LiFePO4', '51.2', '6000 @ 90% DoD'] },
    ].map((p) => ({ ...p, hsnCode: '8507', unit: 'piece', warrantyYears: 5, quantity: 8, specs: specs(['Capacity (kWh)', 'Chemistry', 'Voltage (V)', 'Cycle life'], p.values) })),
  },
  {
    name: 'Metering & Monitoring',
    description: 'Net meters, CTs and remote monitoring.',
    specKeys: ['Type', 'Accuracy class', 'Communication'],
    products: [
      { name: 'Secure bi-directional net meter (single phase)', brand: 'Secure', model: 'Premier 300', sku: 'MTR-SC-1P', price: 3800, values: ['Bi-directional', '1.0', 'RS485'] },
      { name: 'HPL bi-directional net meter (three phase, CT)', brand: 'HPL', model: 'Trimax 3P4W', sku: 'MTR-HP-3P', price: 6900, values: ['Bi-directional', '0.5S', 'RS485'] },
      { name: 'Wi-Fi data logger & CT kit', brand: 'Growatt', model: 'Shine WiFi-X', sku: 'MON-GW-WF', price: 4500, values: ['Data logger', '—', 'Wi-Fi'] },
    ].map((p) => ({ ...p, hsnCode: '9028', unit: 'piece', warrantyYears: 5, quantity: 40, specs: specs(['Type', 'Accuracy class', 'Communication'], p.values) })),
  },
];

/** Packages: each line names a product from above (by SKU) and how many. */
export const SHOWCASE_PACKAGES = [
  { name: '3 kW Residential On-Grid Package', kw: 3, price: 172000, description: 'Complete 3 kW rooftop system for a home: 7 × 440 Wp Tata panels, 3.3 kW inverter, structure, cabling, earthing and net-metering.', lines: [['PNL-TP-440', 7], ['INV-HV-3K', 1], ['MMS-AL-KW', 3], ['CAB-DC-4', 1], ['CAB-AC-10', 25], ['ERT-AS-3M', 2], ['ACDB-LT-25', 1], ['DCDB-HN-11', 1], ['MTR-SC-1P', 1], ['MON-GW-WF', 1]] },
  { name: '5 kW Residential Premium Package', kw: 5, price: 268000, description: '5 kW system with 9 × 575 Wp Adani TOPCon panels, Growatt 5 kW inverter and Wi-Fi monitoring.', lines: [['PNL-AD-575', 9], ['INV-GW-5K', 1], ['MMS-AL-KW', 5], ['CAB-DC-4', 2], ['CAB-AC-10', 30], ['ERT-AS-3M', 2], ['ACDB-LT-25', 1], ['DCDB-HN-22', 1], ['MTR-SC-1P', 1], ['MON-GW-WF', 1]] },
  { name: '10 kW Three-Phase Commercial Package', kw: 10, price: 505000, description: '10 kW three-phase system for shops and small offices: 17 × 620 Wp Premier panels and Sungrow 10 kW inverter.', lines: [['PNL-PE-620', 17], ['INV-SG-10K', 1], ['MMS-GI-KW', 10], ['CAB-DC-6', 2], ['CAB-AC-16', 40], ['ERT-AS-3M', 3], ['ACDB-SE-32', 1], ['DCDB-HN-22', 2], ['MTR-HP-3P', 1], ['MON-GW-WF', 1]] },
  { name: '25 kW Industrial Rooftop Package', kw: 25, price: 1180000, description: '25 kW industrial rooftop plant with 41 × 620 Wp panels and a Sungrow 25 kW inverter.', lines: [['PNL-PE-620', 41], ['INV-SG-25K', 1], ['MMS-GI-KW', 25], ['CAB-DC-6', 4], ['CAB-AC-16', 60], ['ERT-AS-CP', 2], ['ACDB-HV-63', 1], ['DCDB-HV-42', 3], ['MTR-HP-3P', 1], ['MON-GW-WF', 1]] },
];

/* ───────────── clients ───────────── */

export const SHOWCASE_CLIENTS = [
  { key: 'joshi', name: 'Amit Joshi', email: 'amit.joshi@example.com', phone: '9822011223', pan: 'ABMPJ5643D', address: 'Flat 6, Shreyas Apartments, Karve Road, Kothrud, Pune, Maharashtra 411038', consumerNumber: '170012345678', kwRequired: 5, source: 'Website', notes: 'Monthly bill about ₹6,800. Wants a 5 kW system with net metering.' },
  { key: 'deshmukh', name: 'Priya Deshmukh', email: 'priya.deshmukh@example.com', phone: '9011023456', pan: 'CDRPD7821F', address: 'B-402, Lotus Residency, Pashan, Pune, Maharashtra 411021', consumerNumber: '170033445566', kwRequired: 3, source: 'Google Search', referredBy: { name: 'Amit Joshi', phone: '9822011223' }, notes: 'Terrace flat owner; asked about the PM Surya Ghar subsidy.' },
  { key: 'school', name: 'Green Valley English Medium School', email: 'office@greenvalleyschool.in', phone: '9860044400', pan: 'AAATG1234B', address: 'Survey No. 44, Wakad, Pimpri-Chinchwad, Maharashtra 411057', consumerNumber: '170098471203', kwRequired: 25, source: 'Referral', referredBy: { name: 'Dr. Suhas Kulkarni', phone: '9422033445' }, notes: 'Trust-run school with a three-phase LT connection and high daytime use.' },
  { key: 'mehta', name: 'Mehta Textiles Pvt Ltd', email: 'accounts@mehtatextiles.in', phone: '9850077120', pan: 'AACCM2314K', address: 'Plot 18, MIDC Bhosari, Pune, Maharashtra 411026', consumerNumber: '170077182901', kwRequired: 50, source: 'Industrial Expo', notes: 'Tin-shed factory roof; wants bifacial panels.' },
  { key: 'patil', name: 'Sunil Patil', email: 'sunil.patil@example.com', phone: '9765012345', pan: 'EFGPS3345H', address: 'Sai Bungalow, Gangapur Road, Nashik, Maharashtra 422013', consumerNumber: '150022334455', kwRequired: 8, source: 'Social Media', notes: 'Independent bungalow, south-facing terrace.' },
  { key: 'hospital', name: 'Aarogya Multispeciality Hospital', email: 'admin@aarogyahospital.in', phone: '9890055667', pan: 'AAFFH5678P', address: '15, Model Colony, Shivajinagar, Pune, Maharashtra 411016', consumerNumber: '170055667788', kwRequired: 30, source: 'Direct Walk-in', notes: 'Wants daytime load offset; ICU backup handled separately.' },
  { key: 'iyer', name: 'Lakshmi Iyer', email: 'lakshmi.iyer@example.com', phone: '9822198700', pan: 'HJKPI9087M', address: 'A-12, Rajmata Society, Aundh, Pune, Maharashtra 411007', consumerNumber: '170011223344', kwRequired: 4, source: 'Referral', referredBy: { name: 'Priya Deshmukh', phone: '9011023456' }, notes: 'Housing society row-house; shadow from a neighbouring building in the evening.' },
  { key: 'sharma', name: 'Vinod Sharma', email: 'vinod.sharma@example.com', phone: '9309876543', pan: 'LMNPS6654A', address: 'Plot 7, Sector 27, Nigdi, Pimpri-Chinchwad, Maharashtra 411044', consumerNumber: '170099887766', kwRequired: 6, source: 'Website', notes: 'Wants a 6 kW system before summer.' },
];

/* ───────────── designs (client key, name, status, size, roof) ───────────── */

export const SHOWCASE_DESIGNS = [
  { client: 'joshi', name: 'Joshi residence – 5 kW rooftop', status: 'won', summary: { kwp: 5.18, panels: 9, cost: 268000, annualKwh: 7700 }, data: site('Karve Road, Kothrud, Pune, Maharashtra 411038', 18.50746, 73.80764, rect(11, 8), 9) },
  { client: 'school', name: 'Green Valley School – main block', status: 'won', summary: { kwp: 24.8, panels: 40, cost: 1180000, annualKwh: 36500 }, data: site('Wakad, Pimpri-Chinchwad, Maharashtra 411057', 18.5987, 73.7602, rect(30, 22), 12) },
  { client: 'hospital', name: 'Aarogya Hospital – terrace plant', status: 'won', summary: { kwp: 30.4, panels: 49, cost: 1420000, annualKwh: 44800 }, data: site('Shivajinagar, Pune, Maharashtra 411016', 18.5308, 73.8474, lShape(26, 20, 8, 7), 15) },
  { client: 'deshmukh', name: 'Deshmukh terrace – 3 kW', status: 'proposed', summary: { kwp: 3.08, panels: 7, cost: 172000, annualKwh: 4550 }, data: site('Pashan, Pune, Maharashtra 411021', 18.5362, 73.7907, rect(8, 6), 12) },
  { client: 'mehta', name: 'Mehta Textiles – shed A', status: 'proposed', summary: { kwp: 50.7, panels: 82, cost: 2350000, annualKwh: 74800 }, data: site('MIDC Bhosari, Pune, Maharashtra 411026', 18.6298, 73.8451, rect(40, 26), 8) },
  { client: 'patil', name: 'Patil bungalow – 8 kW', status: 'proposed', summary: { kwp: 8.1, panels: 15, cost: 412000, annualKwh: 12100 }, data: site('Gangapur Road, Nashik, Maharashtra 422013', 20.0148, 73.7452, rect(14, 10), 7) },
  { client: 'iyer', name: 'Iyer row-house – 4 kW', status: 'draft' },
  { client: 'sharma', name: 'Sharma residence – 6 kW', status: 'draft' },
  { client: 'joshi', name: 'Joshi residence – 8 kW option', status: 'lost', summary: { kwp: 8.1, panels: 15, cost: 412000, annualKwh: 11900 }, data: site('Karve Road, Kothrud, Pune, Maharashtra 411038', 18.50746, 73.80764, rect(11, 8), 9) },
];

/** Installations of the "won" designs: how far along each is, and who does the steps. */
export const SHOWCASE_INSTALLATIONS = [
  {
    design: 'Joshi residence – 5 kW rooftop',
    startedDaysAgo: 34,
    // per step: [status, assignee (agent email prefix), days ago the step finished / started, note]
    steps: [
      ['done', 'farah.sayyed', 31, 'Roof measured: 11 × 8 m usable, no shading from the water tank.'],
      ['done', 'sneha.kulkarni', 27, 'Panels, inverter and cables delivered and checked against the packing list.'],
      ['done', 'ganesh.jadhav', 22, 'Structure fixed on 6 pedestals; wind-load check done.'],
      ['done', 'imran.shaikh', 15, '9 panels, DC/AC cabling, inverter and earthing complete.'],
      ['done', 'sandeep.patil', 9, 'Commissioned. Net-meter installed by MSEDCL; handed over to the client.'],
    ],
  },
  {
    design: 'Green Valley School – main block',
    startedDaysAgo: 12,
    steps: [
      ['done', 'sandeep.patil', 9, 'Terrace surveyed; parapet height 1 m, shadow-free between 9 am and 4 pm.'],
      ['done', 'sneha.kulkarni', 4, 'All 40 panels and the 25 kW inverter received at site.'],
      ['in_progress', 'ganesh.jadhav', 1, 'Pedestal casting done; rail fixing in progress.'],
      ['pending', 'amol.deshpande', null, ''],
      ['pending', 'sandeep.patil', null, ''],
    ],
  },
  {
    design: 'Aarogya Hospital – terrace plant',
    startedDaysAgo: 3,
    steps: [
      ['in_progress', 'farah.sayyed', 1, 'Site visit scheduled with the hospital engineer.'],
      ['pending', 'sneha.kulkarni', null, ''],
      ['pending', 'ganesh.jadhav', null, ''],
      ['pending', 'imran.shaikh', null, ''],
      ['pending', 'sandeep.patil', null, ''],
    ],
  },
];

export const SHOWCASE_TICKETS = [
  {
    subject: 'Invoice for the Pro plan renewal',
    category: 'billing',
    priority: 'normal',
    status: 'resolved',
    daysAgo: 9,
    messages: [
      ['company', 'Hello, could you send the GST invoice for this month’s Pro plan renewal? We need it for our accounts team.', 9],
      ['admin', 'Hi Rajesh, the invoice for this cycle has been generated and emailed to info@suryashakti.in. Please check your spam folder if you can’t find it.', 8],
      ['company', 'Got it, thank you. Received.', 8],
    ],
  },
  {
    subject: 'Import panel list from Excel',
    category: 'technical',
    priority: 'high',
    status: 'open',
    daysAgo: 1,
    messages: [
      ['company', 'We have 60 panel models in an Excel sheet. Is there a template for the panel import? The import button rejects our file.', 1],
    ],
  },
];
