import { PlanRequest } from '../models/index.js';

// Requests made while payments ran through Razorpay: 'active' → 'approved'; 'quoted' / 'awaiting_payment' → 'pending'
// (the admin can now approve or reject them); payment fields are dropped.
export async function migratePlanRequests() {
  const c = PlanRequest.collection;
  const approved = await c.updateMany({ status: 'active' }, { $set: { status: 'approved' } });
  const pending = await c.updateMany({ status: { $in: ['quoted', 'awaiting_payment'] } }, { $set: { status: 'pending' } });
  await c.updateMany({}, { $unset: { paymentToken: '', paymentLinkSentAt: '', paidAt: '', razorpayPlanId: '', razorpaySubscriptionId: '', razorpayOrderId: '', checkoutMode: '', priceBreakdown: '' } });
  if (approved.modifiedCount + pending.modifiedCount) console.log(`Plan requests migrated: ${approved.modifiedCount} approved, ${pending.modifiedCount} reopened as pending`);
}
