/**
 * Custom plan pricing — edit these rules only; controllers must not hardcode amounts.
 * All amounts are INR per month unless noted.
 *
 * Formula per dimension:
 *   cost = base + max(0, quantity - included) * pricePerUnit
 */
export const CUSTOM_PLAN_PRICING = {
  currency: 'INR',
  billingCycle: 'monthly',
  minimumMonthly: 0,
  concurrentLogins: {
    min: 1,
    max: 500,
    included: 0,
    base: 0,
    pricePerUnit: 1000,
  },
};
