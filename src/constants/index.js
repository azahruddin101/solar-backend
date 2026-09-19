export const ROLES = { SUPERADMIN: 'superadmin', COMPANY: 'company' };
export const COMPANY_STATUS = ['active', 'suspended'];
export const PLANS = ['starter', 'growth', 'enterprise'];
export const DESIGN_STATUS = ['draft', 'proposed', 'won', 'lost'];
export const PILLAR_SHAPES = ['l-shape', 'cylindrical', 'square'];
export const ASSET_KINDS = ['logo', 'signature', 'qr'];
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Starter catalog given to every new company so it can design right away.
export const DEFAULT_PANELS = [
  { brand: 'Waaree', model: 'WS-300', watts: 300, length: 1.65, width: 0.99, price: 7500, warrantyYears: 25 },
  { brand: 'Tata Power Solar', model: 'TP-400', watts: 400, length: 1.88, width: 1.05, price: 10500, warrantyYears: 25 },
  { brand: 'Adani Solar', model: 'ASM-500', watts: 500, length: 2.19, width: 1.1, price: 13500, warrantyYears: 30 },
];
export const DEFAULT_PILLARS = [
  { name: 'MS angle 50×50×5', shape: 'l-shape', pricePerFt: 95 },
  { name: 'GI round pipe 2"', shape: 'cylindrical', pricePerFt: 140 },
  { name: 'GI square tube 60×60', shape: 'square', pricePerFt: 165 },
];
