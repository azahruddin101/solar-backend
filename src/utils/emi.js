/** The monthly EMI (reducing balance, whole rupees) for a loan amount, a yearly interest rate in % and a period in months; 0 when it can't be worked out. */
export function monthlyEmi(amount, ratePercent, months) {
  const P = Number(amount) || 0;
  const n = Math.round(Number(months) || 0);
  const r = (Number(ratePercent) || 0) / 1200;
  if (!(P > 0) || !(n > 0)) return 0;
  return Math.round(r > 0 ? (P * r * (1 + r) ** n) / ((1 + r) ** n - 1) : P / n);
}
