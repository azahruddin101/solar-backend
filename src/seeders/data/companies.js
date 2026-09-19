// Demo tenants. Every company signs in with DEMO_PASSWORD (see ../index.js output).
// Roof outlines are in metres relative to the site origin (x = east, y = north).

const rect = (w, d) => [{ x: -w / 2, y: -d / 2 }, { x: w / 2, y: -d / 2 }, { x: w / 2, y: d / 2 }, { x: -w / 2, y: d / 2 }];
const lShape = (w, d, cutW, cutD) => [{ x: -w / 2, y: -d / 2 }, { x: w / 2, y: -d / 2 }, { x: w / 2, y: d / 2 - cutD }, { x: w / 2 - cutW, y: d / 2 - cutD }, { x: w / 2 - cutW, y: d / 2 }, { x: -w / 2, y: d / 2 }];

const site = (address, lat, lng, points, height = 6) => ({
  place: { address, location: { lat, lng } },
  origin: { lat, lng },
  sections: [{ id: 'r-main', name: 'Main roof', points, height, parapetH: 1, parapetT: 0.23 }],
  objects: [],
});

export const DEMO_PASSWORD = 'Demo@12345';

export const COMPANIES = [
  {
    login: { email: 'demo@sunrisesolar.in', name: 'Anita Sharma' },
    company: {
      name: 'Sunrise Solar Pvt Ltd',
      email: 'hello@sunrisesolar.in',
      phone: '+91 98200 12345',
      address: '214 Business Park, Baner Road, Pune, Maharashtra 411045',
      website: 'www.sunrisesolar.in',
      taxId: '27AAACS1234F1Z5',
      plan: 'growth',
      theme: { primary: '#1d4ed8', accent: '#f59e0b' },
      signatoryName: 'Anita Sharma',
      signatoryTitle: 'Director',
      qrLabel: 'Scan to visit sunrisesolar.in',
      tagline: 'Powering homes with sunshine',
      pdfTerms: [
        '<h3>Validity &amp; payment</h3>',
        '<ol><li>This proposal is valid for <strong>30 days</strong> from the date of issue.</li>',
        '<li>Payment schedule: <strong>50%</strong> advance with the order, <strong>40%</strong> on material delivery and <strong>10%</strong> after commissioning.</li>',
        '<li>Prices include GST and standard installation; civil work beyond the mounting pedestals is <em>not</em> included.</li></ol>',
        '<h3>Approvals &amp; warranty</h3>',
        '<ul><li>Net-metering approval and DISCOM charges are <u>subject to the local utility</u>.</li>',
        '<li>Panels carry the manufacturer’s product and performance warranty; our workmanship is covered for <strong>5 years</strong>.</li>',
        '<li>Questions? Write to <a href="mailto:hello@sunrisesolar.in">hello@sunrisesolar.in</a>.</li></ul>',
      ].join(''),
      currency: 'INR',
      tariff: 9.5,
      otherCostPerKw: 18000,
      notes: 'Pilot customer. Onboarded by the sales team.',
    },
    panels: [
      { brand: 'Waaree', model: 'Ahnay WSMD-540', watts: 540, manufactureYear: 2026, warrantyYears: 25, length: 2.28, width: 1.13, price: 13900 },
      { brand: 'Waaree', model: 'Arka WSMDi-445', watts: 445, manufactureYear: 2025, warrantyYears: 25, length: 1.91, width: 1.13, price: 11600 },
      { brand: 'Tata Power Solar', model: 'TP550M-BF', watts: 550, manufactureYear: 2026, warrantyYears: 30, length: 2.28, width: 1.13, price: 15400 },
      { brand: 'Adani Solar', model: 'Shine TOPCon 575', watts: 575, manufactureYear: 2026, warrantyYears: 30, length: 2.28, width: 1.13, price: 16900 },
      { brand: 'Vikram Solar', model: 'Somera VSM.72.400', watts: 400, manufactureYear: 2024, warrantyYears: 27, length: 1.98, width: 1.0, price: 9800 },
      { brand: 'Loom Solar', model: 'Shark 440', watts: 440, manufactureYear: 2025, warrantyYears: 25, length: 1.9, width: 1.13, price: 12200 },
    ],
    pillars: [
      { name: 'MS angle 50×50×5', shape: 'l-shape', pricePerFt: 95 },
      { name: 'GI round pipe 2"', shape: 'cylindrical', pricePerFt: 140 },
      { name: 'GI square tube 60×60', shape: 'square', pricePerFt: 165 },
    ],
    clients: [
      { key: 'ravi', name: 'Ravi Kumar', email: 'ravi.kumar@example.com', phone: '+91 99877 66554', address: '12 MG Road, Camp, Pune, Maharashtra 411001', notes: 'Monthly bill around ₹6,500. Wants net metering.' },
      { key: 'school', name: 'Green Valley School', email: 'office@greenvalley.edu.in', phone: '+91 20 2729 4400', address: 'Survey 44, Wakad, Pune, Maharashtra 411057', notes: 'Trust-run school; decision by the managing committee.' },
      { key: 'mehta', name: 'Mehta Textiles', email: 'accounts@mehtatextiles.in', phone: '+91 98500 77120', address: 'Plot 18, MIDC Bhosari, Pune, Maharashtra 411026' },
      { key: 'priya', name: 'Priya Deshmukh', email: 'priya.d@example.com', phone: '+91 90110 23456', address: 'B-402 Lotus Residency, Kothrud, Pune, Maharashtra 411038' },
    ],
    designs: [
      { client: 'ravi', name: 'Kumar residence – 5 kW rooftop', status: 'won', summary: { kwp: 5.4, panels: 10, cost: 268000, annualKwh: 7850 }, data: site('12 MG Road, Camp, Pune, Maharashtra 411001', 18.51652, 73.87843, rect(11, 8), 6.5) },
      { client: 'school', name: 'Green Valley School – main block', status: 'proposed', summary: { kwp: 32.4, panels: 60, cost: 1512000, annualKwh: 47100 }, data: site('Survey 44, Wakad, Pune, Maharashtra 411057', 18.59912, 73.76261, lShape(34, 20, 12, 8), 10) },
      { client: 'mehta', name: 'Mehta Textiles – shed A', status: 'proposed', summary: { kwp: 54, panels: 100, cost: 2465000, annualKwh: 78600 }, data: site('Plot 18, MIDC Bhosari, Pune, Maharashtra 411026', 18.63054, 73.84712, rect(42, 24), 9) },
      { client: 'priya', name: 'Deshmukh terrace – 3 kW', status: 'draft' },
      { client: 'ravi', name: 'Kumar residence – 8 kW option', status: 'lost', summary: { kwp: 8.1, panels: 15, cost: 389000, annualKwh: 11700 }, data: site('12 MG Road, Camp, Pune, Maharashtra 411001', 18.51652, 73.87843, rect(11, 8), 6.5) },
    ],
  },
  {
    login: { email: 'demo@greenvolt.in', name: 'Karthik Rao' },
    company: {
      name: 'GreenVolt Energy',
      email: 'sales@greenvolt.in',
      phone: '+91 80 4718 2200',
      address: '3rd Floor, 27 Residency Road, Bengaluru, Karnataka 560025',
      website: 'www.greenvolt.in',
      taxId: '29AAGCG5678K1Z2',
      plan: 'starter',
      limits: { maxClients: 25, maxDesigns: 50 },
      features: { pdfBranding: true, excelImport: false },
      theme: { primary: '#047857', accent: '#facc15' },
      signatoryName: 'Karthik Rao',
      signatoryTitle: 'Managing Partner',
      qrLabel: 'Scan to contact GreenVolt',
      tagline: 'Clean energy for a brighter tomorrow',
      pdfTerms: ['Prices include GST and standard installation up to 15 m cable run.', '60% advance, 40% on commissioning.', 'Proposal valid for 21 days.'].join('\n'),
      currency: 'INR',
      tariff: 8.2,
      otherCostPerKw: 16500,
    },
    panels: [
      { brand: 'Waaree', model: 'Ahnay WSMD-540', watts: 540, manufactureYear: 2026, warrantyYears: 25, length: 2.28, width: 1.13, price: 14200 },
      { brand: 'Premier Energies', model: 'PE-TOPCon 580', watts: 580, manufactureYear: 2026, warrantyYears: 30, length: 2.28, width: 1.13, price: 17300 },
      { brand: 'RenewSys', model: 'Deserv Galactic 450', watts: 450, manufactureYear: 2025, warrantyYears: 25, length: 1.91, width: 1.13, price: 11900 },
    ],
    pillars: [
      { name: 'HDG C-channel 41×41', shape: 'square', pricePerFt: 150 },
      { name: 'GI round pipe 1.5"', shape: 'cylindrical', pricePerFt: 118 },
    ],
    clients: [
      { key: 'nair', name: 'Suresh Nair', email: 'suresh.nair@example.com', phone: '+91 98450 11223', address: '88, 4th Cross, Indiranagar, Bengaluru, Karnataka 560038' },
      { key: 'cafe', name: 'Third Wave Bakehouse', email: 'owner@thirdwavebakehouse.in', phone: '+91 80 4100 9090', address: '12 Church Street, Bengaluru, Karnataka 560001' },
      { key: 'apts', name: 'Lakeview Apartments Owners Association', email: 'secretary@lakeviewaoa.in', address: 'Hebbal Kempapura, Bengaluru, Karnataka 560024' },
    ],
    designs: [
      { client: 'nair', name: 'Nair villa – 6 kW', status: 'won', summary: { kwp: 5.94, panels: 11, cost: 294000, annualKwh: 8900 }, data: site('88, 4th Cross, Indiranagar, Bengaluru, Karnataka 560038', 12.97194, 77.64115, rect(12, 9), 7) },
      { client: 'apts', name: 'Lakeview – common area supply', status: 'proposed', summary: { kwp: 21.6, panels: 40, cost: 1043000, annualKwh: 32300 }, data: site('Hebbal Kempapura, Bengaluru, Karnataka 560024', 13.04795, 77.59912, rect(26, 16), 15) },
    ],
  },
  {
    // shows how a suspended tenant looks in the admin console (its sign-in is blocked)
    login: { email: 'demo@heliosrooftops.in', name: 'Farhan Qureshi' },
    company: {
      name: 'Helios Rooftops',
      email: 'info@heliosrooftops.in',
      phone: '+91 22 6610 4000',
      address: '501 Trade Centre, Bandra Kurla Complex, Mumbai, Maharashtra 400051',
      website: 'www.heliosrooftops.in',
      plan: 'enterprise',
      status: 'suspended',
      theme: { primary: '#c2410c', accent: '#0ea5e9' },
      signatoryName: 'Farhan Qureshi',
      signatoryTitle: 'CEO',
      notes: 'Suspended: subscription payment overdue.',
    },
    panels: [{ brand: 'Adani Solar', model: 'Shine TOPCon 575', watts: 575, manufactureYear: 2026, warrantyYears: 30, length: 2.28, width: 1.13, price: 16500 }],
    pillars: [{ name: 'GI square tube 60×60', shape: 'square', pricePerFt: 170 }],
    clients: [{ key: 'warehouse', name: 'Konkan Cold Storage', email: 'ops@konkancold.in', address: 'Taloja MIDC, Navi Mumbai, Maharashtra 410208' }],
    designs: [{ client: 'warehouse', name: 'Konkan Cold Storage – roof 1', status: 'draft' }],
  },
];
