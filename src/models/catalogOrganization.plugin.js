// Catalog documents (parent categories, categories, products) belong to the branch's organization. Code that creates
// them through the catalog service sets `organization` itself; this fills it in for every other path (seeders,
// starter catalogs, scripts) so no catalog document is ever left owned by a single branch.
import mongoose from 'mongoose';

export function catalogOrganizationPlugin(schema) {
  schema.pre('validate', async function setOrganization() {
    if (this.organization || !this.company) return;
    const branch = await mongoose.model('Company').findById(this.company).select('organization').setOptions({ rawBranch: true }).lean();
    this.organization = branch?.organization ?? null;
  });
}
