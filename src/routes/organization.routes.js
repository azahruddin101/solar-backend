import { Router } from 'express';
import * as org from '../controllers/organization.controller.js';
import { mastersOnly, organizationOnly } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadImage } from '../middlewares/upload.middleware.js';

const router = Router();

// the company admin's own pages: every branch, their caps and the combined dashboard
router.get('/overview', organizationOnly, org.getOverview);
router.get('/branches', organizationOnly, org.listBranches);
router.post('/branches', organizationOnly, org.createBranch);
router.patch('/branches/:id', organizationOnly, org.updateBranch);

// shared masters: the company admin, or the owner of a company without branches (see constants/tenant.js)
router.get('/', mastersOnly, org.getOrganization);
router.put('/', mastersOnly, validate(S.companySelfSchema), org.updateOrganization);
router.put('/catalog-settings', mastersOnly, validate(S.catalogSettingsSchema), org.updateCatalogSettings);
router.put('/lead-form', mastersOnly, org.updateLeadForm);
router.put('/installation-steps', mastersOnly, org.updateInstallationSteps);
router.put('/amc-templates', mastersOnly, validate(S.amcTemplatesSchema), org.updateAmcTemplates);
router.put('/loan-steps', mastersOnly, validate(S.loanStepsSchema), org.updateLoanSteps);
router.put('/subsidy-steps', mastersOnly, validate(S.subsidyStepsSchema), org.updateSubsidySteps);
router.put('/expense-reasons', mastersOnly, validate(S.expenseReasonsSchema), org.updateExpenseReasons);
router.post('/assets/:kind', mastersOnly, uploadImage, org.uploadOrganizationAsset);
router.delete('/assets/:kind', mastersOnly, org.deleteOrganizationAsset);

export default router;
