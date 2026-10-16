// Which leads the signed-in user may work on. The main app's /api/leads router sets `req.leadsAssignedTo` to the
// staff member's id unless they may view every lead (the owner, or "Leads › View all"); every lead query and update
// in the controllers then adds this condition, so a telecaller only ever sees and changes the leads assigned to them.
const assignedScope = (req) => (req.leadsAssignedTo ? { assignedTo: req.leadsAssignedTo } : {});

module.exports = { assignedScope };
