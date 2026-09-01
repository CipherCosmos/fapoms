import { ROLE_PERMISSIONS } from '../../modules/auth/role-permissions';
import { AppDataSource } from './data-source';
import { UserEntity } from '../../modules/user/user.entity';
import { RoleEntity } from '../../modules/user/role.entity';
import { PermissionEntity } from '../../modules/user/permission.entity';
import { CapabilityEntity } from '../../modules/user/capability.entity';
import { ResponsibilityEntity } from '../../modules/user/responsibility.entity';
import { OrganizationEntity } from '../../modules/organization/organization.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../../modules/geo/geo.entities';
import { ClientEntity } from '../../modules/client/client.entity';
import { ClientConfigurationEntity } from '../../modules/client/client-configuration.entity';
import { ClientContactEntity } from '../../modules/client/client-contact.entity';
import { ClientBillingEntity } from '../../modules/client/client-billing.entity';
import { AssayerEntity } from '../../modules/assayer/assayer.entity';
import { AssayerCommercialProfileEntity } from '../../modules/assayer/assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from '../../modules/assayer/workforce-attribute.entity';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { BranchContactEntity } from '../../modules/branch/branch-contact.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { ProjectBranchEntity } from '../../modules/project/project-branch.entity';
import { HolidayEntity } from '../../modules/holiday/holiday.entity';
import { ValidationCaseEntity } from '../../modules/validation/validation-case.entity';
import { SystemRole, PermissionResource, PermissionAction, AuthorizationScope, UserStatus, AssayerStatus, AssayerLifecycleStatus, ValidationStatus, ProjectStatus, ProjectBranchStatus, Priority } from '@fapoms/shared';
import * as bcrypt from 'bcrypt';

async function seed() {
  console.log('Starting database seeding...');
  await AppDataSource.initialize();
  console.log('Database connection initialized.');

  try {
    // Clean slate: Truncate existing tables to resolve potential database corruption.
    //
    // The list is filtered against the live schema before it is used, because a single name that
    // no longer exists takes the WHOLE statement down with 42P01 — TRUNCATE is one statement, so
    // there is no partial success. `assayer_government_documents` is exactly how that was found:
    // it was dropped by a later migration, survived in long-lived databases as a leftover table,
    // and therefore kept working here while failing on every FRESH install — the one case where
    // seeding actually matters. Filtering keeps this working the next time a table is renamed or
    // retired, without anyone having to remember to edit this line.
    console.log('Truncating existing tables for clean seed...');
    /**
     * Sample DATA only. The RBAC tables — roles, permissions, capabilities, responsibilities and
     * their join tables — are deliberately NOT here, because migrations own them.
     *
     * They used to be truncated, and it silently broke every fresh install: migrations create a
     * row for all eight SystemRole values, the truncate deleted the lot, and this file only
     * re-creates the three it happens to describe. DESK, AUDITOR, PRODUCT_SUPPORT and CLIENT_USER
     * were left with no row and could not be assigned to anyone — StartupChecks reported
     * "4 role(s) in SystemRole have no row … Run migrations", and running migrations could not fix
     * it because they were already recorded as applied. Seeding sample data must not be able to
     * dismantle the permission system.
     *
     * Nothing is lost by leaving them alone: the permission, capability, responsibility and role
     * seeding below is all find-or-create, and the role branch merges rather than replaces.
     */
    const TRUNCATE_CANDIDATES = [
      'users', 'organizations', 'clients',
      'client_configurations', 'client_contacts', 'client_contracts', 'client_billing', 'assayers',
      'assayer_commercial_profiles', 'assayer_government_documents', 'assayer_documents',
      'assayer_remarks', 'assayer_activities', 'workforce_attributes', 'branches',
      'branch_contacts', 'branch_documents', 'zones', 'projects', 'project_branches', 'assignments',
    ];
    const present: { table_name: string }[] = await AppDataSource.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [TRUNCATE_CANDIDATES],
    );
    const presentNames = new Set(present.map((r) => r.table_name));
    const skipped = TRUNCATE_CANDIDATES.filter((t) => !presentNames.has(t));
    if (skipped.length) {
      console.log(`  skipping ${skipped.length} table(s) not in this schema: ${skipped.join(', ')}`);
    }
    const toTruncate = TRUNCATE_CANDIDATES.filter((t) => presentNames.has(t));
    if (toTruncate.length) {
      // Identifiers cannot be parameterised, so they are quoted individually. Every value comes
      // from the hardcoded list above and is matched against information_schema, never from input.
      const quoted = toTruncate.map((t) => `"${t}"`).join(', ');
      await AppDataSource.query(`TRUNCATE TABLE ${quoted} CASCADE;`);
    }

    // 1. Seed Default Organization
    console.log('Seeding default organization...');
    const orgRepository = AppDataSource.getRepository(OrganizationEntity);
    let defaultOrg = await orgRepository.findOne({ where: { code: 'FAPOMS' } });
    if (!defaultOrg) {
      defaultOrg = orgRepository.create({
        name: 'FAPOMS Private Limited',
        code: 'FAPOMS',
        displayName: 'FAPOMS',
        description: 'Default organization for Field Assay Operations Management System',
        contactEmail: 'info@fapoms.com',
        contactPhone: '+919999999999',
        createdBy: 'system',
        updatedBy: 'system',
      });
      defaultOrg = await orgRepository.save(defaultOrg);
      console.log(`Seeded default organization: ${defaultOrg.name} (${defaultOrg.code})`);
    }

    // 2. Seed Permissions
    console.log('Seeding permissions...');
    const permissionRepository = AppDataSource.getRepository(PermissionEntity);
    const existingPermissions = await permissionRepository.find();
    
    const permissionsToSeed: Partial<PermissionEntity>[] = [];
    
    // Define core permissions across all resources
    const resources = Object.values(PermissionResource);
    const actions = Object.values(PermissionAction);
    const scopes = Object.values(AuthorizationScope);

    // Let's create specific logical permissions instead of full matrix to avoid clutter,
    // but cover all required ones for default roles.
    const permissionMap = new Map<string, PermissionEntity>();

    const defaultPermissions = [
      // Projects
      { resource: PermissionResource.PROJECT, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all projects' },
      { resource: PermissionResource.PROJECT, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create projects within organization' },
      { resource: PermissionResource.PROJECT, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit projects within organization' },
      { resource: PermissionResource.PROJECT, action: PermissionAction.ARCHIVE, scope: AuthorizationScope.ORGANIZATION, description: 'Archive projects within organization' },
      { resource: PermissionResource.PROJECT, action: PermissionAction.CLOSE, scope: AuthorizationScope.ORGANIZATION, description: 'Close projects within organization' },
      { resource: PermissionResource.PROJECT, action: PermissionAction.DELETE, scope: AuthorizationScope.ORGANIZATION, description: 'Delete projects within organization' },

      // Branches
      { resource: PermissionResource.BRANCH, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all branches' },
      { resource: PermissionResource.BRANCH, action: PermissionAction.IMPORT, scope: AuthorizationScope.ORGANIZATION, description: 'Import branches' },
      { resource: PermissionResource.BRANCH, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create branches' },
      { resource: PermissionResource.BRANCH, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit branches' },
      { resource: PermissionResource.BRANCH, action: PermissionAction.DELETE, scope: AuthorizationScope.ORGANIZATION, description: 'Delete branches' },

      // Assignments
      { resource: PermissionResource.ASSIGNMENT, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all assignments' },
      { resource: PermissionResource.ASSIGNMENT, action: PermissionAction.VIEW, scope: AuthorizationScope.ASSIGNED_RECORDS, description: 'View own assignments' },
      { resource: PermissionResource.ASSIGNMENT, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create assignments' },
      { resource: PermissionResource.ASSIGNMENT, action: PermissionAction.NEGOTIATE, scope: AuthorizationScope.ORGANIZATION, description: 'Negotiate assignments' },
      { resource: PermissionResource.ASSIGNMENT, action: PermissionAction.ACCEPT, scope: AuthorizationScope.SELF, description: 'Accept assigned work (Assayer)' },
      { resource: PermissionResource.ASSIGNMENT, action: PermissionAction.CANCEL, scope: AuthorizationScope.ORGANIZATION, description: 'Cancel assignments' },

      // Scheduling
      { resource: PermissionResource.SCHEDULING, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all schedules' },
      { resource: PermissionResource.SCHEDULING, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create schedules' },
      { resource: PermissionResource.SCHEDULING, action: PermissionAction.MODIFY, scope: AuthorizationScope.ORGANIZATION, description: 'Modify schedules' },

      // Documents
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all documents' },
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.UPLOAD, scope: AuthorizationScope.ORGANIZATION, description: 'Upload documents' },
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.GENERATE, scope: AuthorizationScope.ORGANIZATION, description: 'Generate documents' },
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.DOWNLOAD, scope: AuthorizationScope.PLATFORM, description: 'Download all documents' },
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit documents' },
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create documents' },

      // Validation
      { resource: PermissionResource.VALIDATION, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View validation cases' },
      { resource: PermissionResource.VALIDATION, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create validation cases' },
      { resource: PermissionResource.VALIDATION, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit validation cases' },
      { resource: PermissionResource.VALIDATION, action: PermissionAction.ASSIGN, scope: AuthorizationScope.ORGANIZATION, description: 'Assign validation cases' },
      { resource: PermissionResource.VALIDATION, action: PermissionAction.REVIEW, scope: AuthorizationScope.ASSIGNED_RECORDS, description: 'Review assigned validation cases' },
      { resource: PermissionResource.VALIDATION, action: PermissionAction.APPROVE, scope: AuthorizationScope.ORGANIZATION, description: 'Approve validations' },

      // Client management
      { resource: PermissionResource.CLIENT, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all clients' },
      { resource: PermissionResource.CLIENT, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create clients within organization' },
      { resource: PermissionResource.CLIENT, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit clients within organization' },
      { resource: PermissionResource.CLIENT, action: PermissionAction.DELETE, scope: AuthorizationScope.ORGANIZATION, description: 'Delete clients within organization' },

      // Planning
      { resource: PermissionResource.PLANNING, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all planning data' },
      { resource: PermissionResource.PLANNING, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create planning scenarios' },
      { resource: PermissionResource.PLANNING, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit planning scenarios' },
      { resource: PermissionResource.PLANNING, action: PermissionAction.DELETE, scope: AuthorizationScope.ORGANIZATION, description: 'Delete planning scenarios' },

      // Billing
      { resource: PermissionResource.BILLING, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all billing data' },
      { resource: PermissionResource.BILLING, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create bills' },
      { resource: PermissionResource.BILLING, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit bills' },
      { resource: PermissionResource.BILLING, action: PermissionAction.APPROVE, scope: AuthorizationScope.ORGANIZATION, description: 'Approve bills' },

      // Assayers
      { resource: PermissionResource.ASSAYER, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all assayers' },
      { resource: PermissionResource.ASSAYER, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create assayers' },
      { resource: PermissionResource.ASSAYER, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit assayers' },
      { resource: PermissionResource.ASSAYER, action: PermissionAction.DELETE, scope: AuthorizationScope.ORGANIZATION, description: 'Delete assayers' },

      // Reference Data (Zones, Geographies, Communications)
      { resource: PermissionResource.REFERENCE_DATA, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View reference data' },
      { resource: PermissionResource.REFERENCE_DATA, action: PermissionAction.CREATE, scope: AuthorizationScope.ORGANIZATION, description: 'Create reference data' },
      { resource: PermissionResource.REFERENCE_DATA, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit reference data' },
      { resource: PermissionResource.REFERENCE_DATA, action: PermissionAction.DELETE, scope: AuthorizationScope.ORGANIZATION, description: 'Delete reference data' },

      // Administration
      { resource: PermissionResource.USER, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View users' },
      { resource: PermissionResource.USER, action: PermissionAction.CREATE, scope: AuthorizationScope.PLATFORM, description: 'Create users' },
      { resource: PermissionResource.USER, action: PermissionAction.EDIT, scope: AuthorizationScope.PLATFORM, description: 'Edit users' },
      { resource: PermissionResource.CONFIGURATION, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View system configuration' },
      { resource: PermissionResource.CONFIGURATION, action: PermissionAction.EDIT, scope: AuthorizationScope.PLATFORM, description: 'Edit system configuration' },
      { resource: PermissionResource.AUDIT_LOG, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View audit logs' },
    ];

    for (const dp of defaultPermissions) {
      const existing = existingPermissions.find(p => p.resource === dp.resource && p.action === dp.action && p.scope === dp.scope);
      if (!existing) {
        const perm = permissionRepository.create({
          resource: dp.resource,
          action: dp.action,
          scope: dp.scope,
          description: dp.description,
          createdBy: 'system',
          updatedBy: 'system',
        });
        const saved = await permissionRepository.save(perm);
        permissionMap.set(`${dp.resource}:${dp.action}:${dp.scope}`, saved);
      } else {
        permissionMap.set(`${dp.resource}:${dp.action}:${dp.scope}`, existing);
      }
    }

    // 3. Seed Capabilities
    console.log('Seeding capabilities...');
    const capabilityRepository = AppDataSource.getRepository(CapabilityEntity);
    const existingCapabilities = await capabilityRepository.find();

    const capabilityDefinitions = [
      { name: 'PROJECT_VIEW', displayName: 'View Projects', category: 'PROJECT', permissionKeys: ['PROJECT:VIEW:PLATFORM'] },
      { name: 'PROJECT_CREATE', displayName: 'Create Projects', category: 'PROJECT', permissionKeys: ['PROJECT:CREATE:ORGANIZATION'] },
      { name: 'PROJECT_EDIT', displayName: 'Edit Projects', category: 'PROJECT', permissionKeys: ['PROJECT:EDIT:ORGANIZATION'] },
      { name: 'PROJECT_ARCHIVE', displayName: 'Archive Projects', category: 'PROJECT', permissionKeys: ['PROJECT:ARCHIVE:ORGANIZATION'] },
      { name: 'PROJECT_CLOSE', displayName: 'Close Projects', category: 'PROJECT', permissionKeys: ['PROJECT:CLOSE:ORGANIZATION'] },
      { name: 'BRANCH_VIEW', displayName: 'View Branches', category: 'BRANCH', permissionKeys: ['BRANCH:VIEW:PLATFORM'] },
      { name: 'BRANCH_IMPORT', displayName: 'Import Branches', category: 'BRANCH', permissionKeys: ['BRANCH:IMPORT:ORGANIZATION'] },
      { name: 'BRANCH_EDIT', displayName: 'Edit Branches', category: 'BRANCH', permissionKeys: ['BRANCH:EDIT:ORGANIZATION'] },
      { name: 'ASSIGNMENT_VIEW', displayName: 'View All Assignments', category: 'ASSIGNMENT', permissionKeys: ['ASSIGNMENT:VIEW:PLATFORM'] },
      { name: 'ASSIGNMENT_VIEW_OWN', displayName: 'View Own Assignments', category: 'ASSIGNMENT', permissionKeys: ['ASSIGNMENT:VIEW:ASSIGNED_RECORDS'] },
      { name: 'ASSIGNMENT_CREATE', displayName: 'Create Assignments', category: 'ASSIGNMENT', permissionKeys: ['ASSIGNMENT:CREATE:ORGANIZATION'] },
      { name: 'ASSIGNMENT_NEGOTIATE', displayName: 'Negotiate Assignments', category: 'ASSIGNMENT', permissionKeys: ['ASSIGNMENT:NEGOTIATE:ORGANIZATION'] },
      { name: 'ASSIGNMENT_ACCEPT', displayName: 'Accept Assigned Work', category: 'ASSIGNMENT', permissionKeys: ['ASSIGNMENT:ACCEPT:SELF'] },
      { name: 'ASSIGNMENT_CANCEL', displayName: 'Cancel Assignments', category: 'ASSIGNMENT', permissionKeys: ['ASSIGNMENT:CANCEL:ORGANIZATION'] },
      { name: 'SCHEDULE_VIEW', displayName: 'View Schedules', category: 'SCHEDULING', permissionKeys: ['SCHEDULING:VIEW:PLATFORM'] },
      { name: 'SCHEDULE_CREATE', displayName: 'Create Schedules', category: 'SCHEDULING', permissionKeys: ['SCHEDULING:CREATE:ORGANIZATION'] },
      { name: 'SCHEDULE_MODIFY', displayName: 'Modify Schedules', category: 'SCHEDULING', permissionKeys: ['SCHEDULING:MODIFY:ORGANIZATION'] },
      { name: 'DOCUMENT_UPLOAD', displayName: 'Upload Documents', category: 'DOCUMENT', permissionKeys: ['DOCUMENT:UPLOAD:ORGANIZATION'] },
      { name: 'DOCUMENT_GENERATE', displayName: 'Generate Documents', category: 'DOCUMENT', permissionKeys: ['DOCUMENT:GENERATE:ORGANIZATION'] },
      { name: 'DOCUMENT_DOWNLOAD', displayName: 'Download Documents', category: 'DOCUMENT', permissionKeys: ['DOCUMENT:DOWNLOAD:PLATFORM'] },
      { name: 'VALIDATION_ASSIGN', displayName: 'Assign Validation Cases', category: 'VALIDATION', permissionKeys: ['VALIDATION:ASSIGN:ORGANIZATION'] },
      { name: 'VALIDATION_REVIEW', displayName: 'Review Validation Cases', category: 'VALIDATION', permissionKeys: ['VALIDATION:REVIEW:ASSIGNED_RECORDS'] },
      { name: 'VALIDATION_APPROVE', displayName: 'Approve Validations', category: 'VALIDATION', permissionKeys: ['VALIDATION:APPROVE:ORGANIZATION'] },
      { name: 'USER_VIEW', displayName: 'View Users', category: 'USER', permissionKeys: ['USER:VIEW:PLATFORM'] },
      { name: 'USER_CREATE', displayName: 'Create Users', category: 'USER', permissionKeys: ['USER:CREATE:PLATFORM'] },
      { name: 'USER_EDIT', displayName: 'Edit Users', category: 'USER', permissionKeys: ['USER:EDIT:PLATFORM'] },
      { name: 'CONFIG_VIEW', displayName: 'View Configuration', category: 'CONFIGURATION', permissionKeys: ['CONFIGURATION:VIEW:PLATFORM'] },
      { name: 'CONFIG_EDIT', displayName: 'Edit Configuration', category: 'CONFIGURATION', permissionKeys: ['CONFIGURATION:EDIT:PLATFORM'] },
      { name: 'AUDIT_LOG_VIEW', displayName: 'View Audit Logs', category: 'AUDIT_LOG', permissionKeys: ['AUDIT_LOG:VIEW:PLATFORM'] },
    ];

    const capabilityMap = new Map<string, CapabilityEntity>();

    for (const cd of capabilityDefinitions) {
      let capability = existingCapabilities.find(c => c.name === cd.name);
      const capPerms = cd.permissionKeys
        .map(key => permissionMap.get(key))
        .filter((p): p is PermissionEntity => !!p);

      if (!capability) {
        capability = capabilityRepository.create({
          name: cd.name,
          displayName: cd.displayName,
          category: cd.category,
          permissions: capPerms,
          createdBy: 'system',
          updatedBy: 'system',
        });
      } else {
        capability.permissions = capPerms;
      }
      const saved = await capabilityRepository.save(capability);
      capabilityMap.set(cd.name, saved);
    }

    // 4. Seed Responsibilities
    console.log('Seeding responsibilities...');
    const responsibilityRepository = AppDataSource.getRepository(ResponsibilityEntity);
    const existingResponsibilities = await responsibilityRepository.find();

    const responsibilityDefinitions = [
      { name: 'PROJECT_MANAGEMENT', displayName: 'Project Management', description: 'Create, edit, archive, and close projects', capabilityNames: ['PROJECT_VIEW', 'PROJECT_CREATE', 'PROJECT_EDIT', 'PROJECT_ARCHIVE', 'PROJECT_CLOSE'] },
      { name: 'PROJECT_VIEWING', displayName: 'Project Viewing', description: 'View projects', capabilityNames: ['PROJECT_VIEW'] },
      { name: 'BRANCH_MANAGEMENT', displayName: 'Branch Management', description: 'Import and manage branch data', capabilityNames: ['BRANCH_VIEW', 'BRANCH_IMPORT', 'BRANCH_EDIT'] },
      { name: 'BRANCH_VIEWING', displayName: 'Branch Viewing', description: 'View branch data', capabilityNames: ['BRANCH_VIEW'] },
      { name: 'ASSIGNMENT_MANAGEMENT', displayName: 'Assignment Management', description: 'Create, negotiate, and cancel assignments', capabilityNames: ['ASSIGNMENT_VIEW', 'ASSIGNMENT_CREATE', 'ASSIGNMENT_NEGOTIATE', 'ASSIGNMENT_CANCEL'] },
      { name: 'ASSIGNMENT_EXECUTION', displayName: 'Assignment Execution', description: 'View and accept assigned work', capabilityNames: ['ASSIGNMENT_VIEW_OWN', 'ASSIGNMENT_ACCEPT'] },
      { name: 'ASSIGNMENT_VIEWING', displayName: 'Assignment Viewing', description: 'View assignments', capabilityNames: ['ASSIGNMENT_VIEW'] },
      { name: 'SCHEDULE_MANAGEMENT', displayName: 'Schedule Management', description: 'Create and modify schedules', capabilityNames: ['SCHEDULE_VIEW', 'SCHEDULE_CREATE', 'SCHEDULE_MODIFY'] },
      { name: 'SCHEDULE_VIEWING', displayName: 'Schedule Viewing', description: 'View schedules', capabilityNames: ['SCHEDULE_VIEW'] },
      { name: 'DOCUMENT_MANAGEMENT', displayName: 'Document Management', description: 'Upload, generate, and download documents', capabilityNames: ['DOCUMENT_UPLOAD', 'DOCUMENT_GENERATE', 'DOCUMENT_DOWNLOAD'] },
      { name: 'DOCUMENT_ACCESS', displayName: 'Document Access', description: 'Download documents', capabilityNames: ['DOCUMENT_DOWNLOAD'] },
      { name: 'VALIDATION_MANAGEMENT', displayName: 'Validation Management', description: 'Assign and approve validations', capabilityNames: ['VALIDATION_ASSIGN', 'VALIDATION_APPROVE'] },
      { name: 'VALIDATION_REVIEWING', displayName: 'Validation Review', description: 'Review assigned validations', capabilityNames: ['VALIDATION_REVIEW'] },
      { name: 'USER_ADMINISTRATION', displayName: 'User Administration', description: 'Manage platform users', capabilityNames: ['USER_VIEW', 'USER_CREATE', 'USER_EDIT'] },
      { name: 'SYSTEM_CONFIGURATION', displayName: 'System Configuration', description: 'Manage system configuration', capabilityNames: ['CONFIG_VIEW', 'CONFIG_EDIT'] },
      { name: 'AUDIT_ACCESS', displayName: 'Audit Log Access', description: 'View audit logs', capabilityNames: ['AUDIT_LOG_VIEW'] },
    ];

    const responsibilityMap = new Map<string, ResponsibilityEntity>();

    for (const rd of responsibilityDefinitions) {
      let responsibility = existingResponsibilities.find(r => r.name === rd.name);
      const respCapabilities = rd.capabilityNames
        .map(name => capabilityMap.get(name))
        .filter((c): c is CapabilityEntity => !!c);

      if (!responsibility) {
        responsibility = responsibilityRepository.create({
          name: rd.name,
          displayName: rd.displayName,
          description: rd.description,
          capabilities: respCapabilities,
          createdBy: 'system',
          updatedBy: 'system',
        });
      } else {
        responsibility.capabilities = respCapabilities;
      }
      const saved = await responsibilityRepository.save(responsibility);
      responsibilityMap.set(rd.name, saved);
    }

    // 5. Seed Roles
    console.log('Seeding roles...');
    const roleRepository = AppDataSource.getRepository(RoleEntity);
    const existingRoles = await roleRepository.find();
    
    /**
     * Roles are built from the one grant table, not from a copy kept here.
     *
     * These lists used to be written out inline, while the roles that arrived later were granted
     * by migrations — so what a role actually held could not be read anywhere. See
     * `modules/auth/role-permissions.ts`, and the parity spec that holds it to what the routes
     * declare.
     */
    const roleDefinitions = [
      {
        name: SystemRole.ADMIN,
        displayName: 'Super Administrator',
        description: 'Unlimited access to all platform features and configuration.',
        permissionKeys: ROLE_PERMISSIONS[SystemRole.ADMIN],
        responsibilityNames: Array.from(responsibilityMap.keys()), // All responsibilities
      },
      {
        name: SystemRole.ADMIN,
        displayName: 'Administrator',
        description: 'Full platform access excluding system configuration.',
        permissionKeys: ROLE_PERMISSIONS[SystemRole.ADMIN],
        responsibilityNames: ['PROJECT_MANAGEMENT', 'BRANCH_MANAGEMENT', 'ASSIGNMENT_MANAGEMENT', 'SCHEDULE_MANAGEMENT', 'DOCUMENT_MANAGEMENT', 'USER_ADMINISTRATION', 'AUDIT_ACCESS'],
      },
      {
        name: SystemRole.OPERATIONS,
        displayName: 'Operations Manager',
        description: 'Manages projects, assignment planning, schedules, and assayers.',
        permissionKeys: ROLE_PERMISSIONS[SystemRole.OPERATIONS],
        responsibilityNames: ['PROJECT_MANAGEMENT', 'BRANCH_MANAGEMENT', 'ASSIGNMENT_MANAGEMENT', 'SCHEDULE_MANAGEMENT', 'DOCUMENT_MANAGEMENT'],
      },
      {
        name: SystemRole.OPERATIONS,
        displayName: 'Operations Executive',
        description: 'Day to day assayer communication, negotiation logging, and scheduling.',
        permissionKeys: ROLE_PERMISSIONS[SystemRole.OPERATIONS],
        responsibilityNames: ['PROJECT_VIEWING', 'BRANCH_VIEWING', 'ASSIGNMENT_VIEWING', 'ASSIGNMENT_MANAGEMENT', 'SCHEDULE_MANAGEMENT', 'DOCUMENT_ACCESS'],
      },
      {
        name: SystemRole.DESK_OPERATOR,
        displayName: 'Validator',
        description: 'Performs OCR manual review and corrections.',
        permissionKeys: ROLE_PERMISSIONS[SystemRole.DESK_OPERATOR],
        responsibilityNames: ['PROJECT_VIEWING', 'VALIDATION_REVIEWING', 'DOCUMENT_ACCESS'],
      },
    ];

    const rolesMap = new Map<SystemRole, RoleEntity>();

    /**
     * Collapse duplicate definitions by role name before anything is written.
     *
     * `roles.name` is UNIQUE, and the list above still carried the pre-consolidation shape: two
     * ADMIN entries (Super Administrator / Administrator) and two OPERATIONS entries (Manager /
     * Executive), left behind when SUPER_ADMIN folded into ADMIN and the two operations roles
     * folded into OPERATIONS. Only the display names still told them apart. The first insert
     * succeeded and the second hit UQ_648e3f5447f725579d7d4ffdfb7 with "Key (name)=(ADMIN)
     * already exists", so `npm run seed` could not finish on a fresh database at all — which is
     * the only kind of database that needs it. Long-lived databases hid this because the roles
     * were already there from a migration.
     *
     * Union rather than pick-one: between them the pair described a single role's full remit, so
     * keeping either alone would quietly narrow it. The first entry's display name and
     * description win, being the broader of the two.
     */
    const mergedRoleDefinitions = [
      ...roleDefinitions
        .reduce((acc, rd) => {
          const prev = acc.get(rd.name);
          if (prev) {
            prev.permissionKeys = [...new Set([...prev.permissionKeys, ...rd.permissionKeys])];
            prev.responsibilityNames = [
              ...new Set([...prev.responsibilityNames, ...rd.responsibilityNames]),
            ];
          } else {
            acc.set(rd.name, {
              ...rd,
              permissionKeys: [...rd.permissionKeys],
              responsibilityNames: [...rd.responsibilityNames],
            });
          }
          return acc;
        }, new Map<string, (typeof roleDefinitions)[number]>())
        .values(),
    ];

    for (const rd of mergedRoleDefinitions) {
      // `existingRoles` is a snapshot taken before this loop, so it never sees a role created by
      // an earlier iteration; `rolesMap` covers that and keeps the lookup correct either way.
      let role = existingRoles.find(r => r.name === rd.name) ?? rolesMap.get(rd.name as SystemRole);
      const rolePermissions = rd.permissionKeys
        .map(key => permissionMap.get(key))
        .filter((p): p is PermissionEntity => !!p);

      const roleResponsibilities = rd.responsibilityNames
        .map(name => responsibilityMap.get(name))
        .filter((r): r is ResponsibilityEntity => !!r);

      if (!role) {
        role = roleRepository.create({
          name: rd.name,
          displayName: rd.displayName,
          description: rd.description,
          permissions: rolePermissions,
          responsibilities: roleResponsibilities,
          createdBy: 'system',
          updatedBy: 'system',
        });
      } else {
        /**
         * Merge, never replace.
         *
         * `role.permissions = rolePermissions` overwrote the row outright. Several resources —
         * HOLIDAY, ZONE, PLANNING, BILLING, CUSTOMER_MASTER — are created and granted by
         * migrations and are absent from this file's `defaultPermissions`, so re-running the
         * seed against a migrated database silently stripped them from SUPER_ADMINISTRATOR,
         * ADMINISTRATOR, OPERATIONS_MANAGER, OPERATIONS_EXECUTIVE and VALIDATOR. That is exactly
         * the every-role-403 outage `BackfillMissingPermissions` was written to repair — the
         * seed could recreate it in one command.
         *
         * A seed's job is to guarantee a baseline exists, not to assert it is the whole truth.
         */
        const byId = new Map((role.permissions ?? []).map((p: any) => [p.id, p]));
        for (const p of rolePermissions) byId.set(p.id, p);
        role.permissions = [...byId.values()];

        const respById = new Map((role.responsibilities ?? []).map((r: any) => [r.id, r]));
        for (const r of roleResponsibilities) respById.set(r.id, r);
        role.responsibilities = [...respById.values()];
      }
      const savedRole = await roleRepository.save(role);
      rolesMap.set(rd.name as SystemRole, savedRole);
    }

    // 7. Seed Users
    console.log('Seeding default users...');
    const userRepository = AppDataSource.getRepository(UserEntity);

    const defaultUsers = [
      { username: 'admin', email: 'admin@fapoms.com', firstName: 'Super', lastName: 'Admin', displayName: 'System Admin', roleName: SystemRole.ADMIN },
      { username: 'admin2', email: 'admin2@fapoms.com', firstName: 'Admin2', lastName: 'User', displayName: 'Admin User', roleName: SystemRole.ADMIN },
      { username: 'manager', email: 'manager@fapoms.com', firstName: 'Operations', lastName: 'Manager', displayName: 'Ops Manager', roleName: SystemRole.OPERATIONS },
      { username: 'executive', email: 'executive@fapoms.com', firstName: 'Operations', lastName: 'Executive', displayName: 'Ops Executive', roleName: SystemRole.OPERATIONS },
      { username: 'validator', email: 'validator@fapoms.com', firstName: 'Senior', lastName: 'Validator', displayName: 'Senior Validator', roleName: SystemRole.DESK_OPERATOR },
    ];

    const passwordHash = await bcrypt.hash('admin123', 12);

    for (const du of defaultUsers) {
      const existingUser = await userRepository.findOne({ where: { username: du.username } });
      if (!existingUser) {
        const role = rolesMap.get(du.roleName);
        const user = userRepository.create({
          username: du.username,
          email: du.email,
          passwordHash,
          firstName: du.firstName,
          lastName: du.lastName,
          displayName: du.displayName,
          status: UserStatus.ACTIVE,
          organizationId: defaultOrg?.id ?? null,
          createdBy: 'system',
          updatedBy: 'system',
          roles: role ? [role] : [],
        });
        await userRepository.save(user);
        console.log(`Created default user: ${du.username} / admin123`);
      }
    }

    // 8. Seed Geographic Master Data
    console.log('Seeding geographic reference states, districts, and cities...');
    const stateRepository = AppDataSource.getRepository(GeoStateEntity);
    const districtRepository = AppDataSource.getRepository(GeoDistrictEntity);
    const cityRepository = AppDataSource.getRepository(GeoCityEntity);

    const statesData = [
      { name: 'Maharashtra', code: 'MH', districts: [
        { name: 'Mumbai', cities: [{ name: 'Mumbai City', pincode: '400001' }] },
        { name: 'Pune', cities: [{ name: 'Pune City', pincode: '411001' }, { name: 'Pimpri-Chinchwad', pincode: '411018' }] },
        { name: 'Nagpur', cities: [{ name: 'Nagpur', pincode: '440001' }] },
        { name: 'Thane', cities: [{ name: 'Thane', pincode: '400601' }] },
        { name: 'Nashik', cities: [{ name: 'Nashik', pincode: '422001' }] },
        { name: 'Aurangabad', cities: [{ name: 'Aurangabad', pincode: '431001' }] },
        { name: 'Solapur', cities: [{ name: 'Solapur', pincode: '413001' }] },
      ]},
      { name: 'Gujarat', code: 'GJ', districts: [
        { name: 'Ahmedabad', cities: [{ name: 'Ahmedabad City', pincode: '380001' }] },
        { name: 'Surat', cities: [{ name: 'Surat City', pincode: '395003' }] },
        { name: 'Vadodara', cities: [{ name: 'Vadodara', pincode: '390001' }] },
        { name: 'Rajkot', cities: [{ name: 'Rajkot', pincode: '360001' }] },
      ]},
      { name: 'Karnataka', code: 'KA', districts: [
        { name: 'Bangalore Urban', cities: [{ name: 'Bangalore', pincode: '560001' }] },
        { name: 'Mysore', cities: [{ name: 'Mysore', pincode: '570001' }] },
        { name: 'Hubli', cities: [{ name: 'Hubli', pincode: '580001' }] },
      ]},
      { name: 'Tamil Nadu', code: 'TN', districts: [
        { name: 'Chennai', cities: [{ name: 'Chennai', pincode: '600001' }] },
        { name: 'Coimbatore', cities: [{ name: 'Coimbatore', pincode: '641001' }] },
      ]},
      { name: 'Uttar Pradesh', code: 'UP', districts: [
        { name: 'Lucknow', cities: [{ name: 'Lucknow', pincode: '226001' }] },
        { name: 'Kanpur', cities: [{ name: 'Kanpur', pincode: '208001' }] },
      ]},
      { name: 'West Bengal', code: 'WB', districts: [
        { name: 'Kolkata', cities: [{ name: 'Kolkata', pincode: '700001' }] },
      ]},
      { name: 'Rajasthan', code: 'RJ', districts: [
        { name: 'Jaipur', cities: [{ name: 'Jaipur', pincode: '302001' }] },
      ]},
      { name: 'Delhi', code: 'DL', districts: [
        { name: 'New Delhi', cities: [{ name: 'New Delhi', pincode: '110001' }] },
      ]},
    ];

    for (const sd of statesData) {
      let state = await stateRepository.findOne({ where: { name: sd.name } });
      if (!state) {
        state = stateRepository.create({
          name: sd.name,
          code: sd.code,
          createdBy: 'system',
          updatedBy: 'system',
        });
        state = await stateRepository.save(state);
      }

      for (const dd of sd.districts) {
        let district = await districtRepository.findOne({ where: { name: dd.name, stateId: state.id } });
        if (!district) {
          district = districtRepository.create({
            name: dd.name,
            stateId: state.id,
            createdBy: 'system',
            updatedBy: 'system',
          });
          district = await districtRepository.save(district);
        }

        for (const cd of dd.cities) {
          let city = await cityRepository.findOne({ where: { name: cd.name, districtId: district.id } });
          if (!city) {
            city = cityRepository.create({
              name: cd.name,
              districtId: district.id,
              pincode: cd.pincode,
              createdBy: 'system',
              updatedBy: 'system',
            });
            await cityRepository.save(city);
          }
        }
      }
    }

    // 9. Seed Client Master Profiles
    console.log('Seeding client master profiles and configurations...');
    const clientRepository = AppDataSource.getRepository(ClientEntity);
    const clientConfigRepository = AppDataSource.getRepository(ClientConfigurationEntity);
    const clientContactRepository = AppDataSource.getRepository(ClientContactEntity);
    const clientBillingRepository = AppDataSource.getRepository(ClientBillingEntity);

    const clientsData = [
      {
        code: 'SBI',
        name: 'State Bank of India',
        displayName: 'SBI Corporate',
        industry: 'Banking',
        clientType: 'BANK',
        registrationNumber: 'CIN-L65110MH1955GOI009526',
        taxId: 'AAACS1234E',
        contactPerson: 'Ramesh Sharma',
        contactEmail: 'ramesh.sharma@sbi.co.in',
        contactPhone: '+919876543210',
        address: 'SBI Corporate Headquarters, Nariman Point, Mumbai',
        lifecycleStatus: 'ACTIVE',
        priority: 'HIGH',
        budget: 5000000,
        mapping: {
          solId: 'SOL ID',
          name: 'Branch Name',
          address: 'Address',
          state: 'State',
          district: 'District',
          city: 'City',
          pincode: 'Pincode',
          latitude: 'Latitude',
          longitude: 'Longitude',
        },
        contacts: [
          { name: 'Ramesh Sharma', email: 'ramesh.sharma@sbi.co.in', phone: '+919876543210', designation: 'Branch Operations Head', department: 'Operations', isPrimary: true },
          { name: 'Priya Patel', email: 'priya.patel@sbi.co.in', phone: '+919876543211', designation: 'Compliance Officer', department: 'Compliance', isPrimary: false },
        ],
        billing: {
          paymentTerms: 'NET45',
          currency: 'INR',
          taxIdentifier: 'AAACS1234E',
          invoiceCycle: 'MONTHLY',
          billingAddress: 'SBI Corporate Headquarters, Nariman Point, Mumbai - 400021',
          bankAccount: '12345678901',
          bankName: 'State Bank of India',
          ifscCode: 'SBIN0000001',
        },
        sla: { maxAuditsPerMonth: 3, schedulingWindowDays: 14, serviceLevel: 'PREMIUM', maxResponseTimeHours: 4 },
        planningPreferences: {
          minDistanceKm: 5,
          maxDistanceKm: 200,
          requiredSkills: ['Gold Valuation'],
          preferredSkills: ['Financial Auditing', 'Agricultural Audit'],
          requiredCertifications: ['Certified Gold Assayer'],
          preferredCertifications: ['Gold Valuation Specialist'],
          weights: { distance: 0.25, clientPreference: 0.15, branchFamiliarity: 0.15 },
        },
      },
      {
        code: 'HDFC',
        name: 'HDFC Bank Limited',
        displayName: 'HDFC Audit',
        industry: 'Banking',
        clientType: 'BANK',
        registrationNumber: 'CIN-L65110MH1994PLC080618',
        taxId: 'AAACH5678F',
        contactPerson: 'Anjali Verma',
        contactEmail: 'anjali.verma@hdfcbank.com',
        contactPhone: '+919988776655',
        address: 'HDFC Bank House, Senapati Bapat Marg, Lower Parel, Mumbai',
        lifecycleStatus: 'ACTIVE',
        priority: 'HIGH',
        budget: 3500000,
        mapping: {
          solId: 'SolId',
          name: 'BranchName',
          address: 'BranchAddress',
          state: 'StateName',
          district: 'DistrictName',
          city: 'CityName',
          pincode: 'Pin',
          latitude: 'Lat',
          longitude: 'Lng',
        },
        contacts: [
          { name: 'Anjali Verma', email: 'anjali.verma@hdfcbank.com', phone: '+919988776655', designation: 'Audit Coordinator', department: 'Internal Audit', isPrimary: true },
        ],
        billing: {
          paymentTerms: 'NET30',
          currency: 'INR',
          taxIdentifier: 'AAACH5678F',
          invoiceCycle: 'MONTHLY',
          billingAddress: 'HDFC Bank House, Senapati Bapat Marg, Lower Parel, Mumbai - 400013',
          bankAccount: '98765432101',
          bankName: 'HDFC Bank',
          ifscCode: 'HDFC0000001',
        },
        sla: { maxAuditsPerMonth: 2, schedulingWindowDays: 10, serviceLevel: 'STANDARD', maxResponseTimeHours: 8 },
        planningPreferences: {
          minDistanceKm: 10,
          maxDistanceKm: 150,
          requiredSkills: ['Gold Valuation'],
          preferredSkills: ['Gold'],
          requiredCertifications: [],
          preferredCertifications: ['Certified Gold Assayer'],
          weights: { distance: 0.20, cost: 0.15, performance: 0.15 },
        },
      },
    ];

    for (const cd of clientsData) {
      let client = await clientRepository.findOne({ where: { clientCode: cd.code } });
      if (!client) {
        const config = clientConfigRepository.create({
          importMapping: cd.mapping,
          workingDays: [1, 2, 3, 4, 5],
          defaultRadius: 50.0,
          slaRules: cd.sla,
          serviceLevel: cd.sla.serviceLevel,
          maxResponseTimeHours: cd.sla.maxResponseTimeHours,
          effectiveFrom: new Date(),
          createdBy: 'system',
          updatedBy: 'system',
        });

        client = clientRepository.create({
          clientCode: cd.code,
          name: cd.name,
          displayName: cd.displayName,
          industry: cd.industry,
          clientType: cd.clientType,
          registrationNumber: cd.registrationNumber,
          taxId: cd.taxId,
          lifecycleStatus: cd.lifecycleStatus,
          contactPerson: cd.contactPerson,
          contactEmail: cd.contactEmail,
          contactPhone: cd.contactPhone,
          address: cd.address,
          priority: cd.priority,
          budget: cd.budget,
          planningPreferences: cd.planningPreferences || null,
          configuration: config,
          organizationId: defaultOrg.id,
          createdBy: 'system',
          updatedBy: 'system',
        });

        await clientRepository.save(client);
        console.log(`Seeded client: ${cd.name} (${cd.code})`);

        // Seed contacts
        for (const c of cd.contacts) {
          const existingContact = await clientContactRepository.findOne({ where: { clientId: client.id, email: c.email } });
          if (!existingContact) {
            const contact = clientContactRepository.create({
              clientId: client.id,
              name: c.name,
              email: c.email,
              phone: c.phone,
              designation: c.designation,
              department: c.department,
              isPrimary: c.isPrimary,
              createdBy: 'system',
              updatedBy: 'system',
            });
            await clientContactRepository.save(contact);
          }
        }

        // Seed billing
        const existingBilling = await clientBillingRepository.findOne({ where: { clientId: client.id } });
        if (!existingBilling && cd.billing) {
          const billing = clientBillingRepository.create({
            clientId: client.id,
            paymentTerms: cd.billing.paymentTerms,
            currency: cd.billing.currency,
            taxIdentifier: cd.billing.taxIdentifier,
            invoiceCycle: cd.billing.invoiceCycle,
            billingAddress: cd.billing.billingAddress,
            bankAccount: cd.billing.bankAccount,
            bankName: cd.billing.bankName,
            ifscCode: cd.billing.ifscCode,
            createdBy: 'system',
            updatedBy: 'system',
          });
          await clientBillingRepository.save(billing);
        }
      }
    }

    // 10. Seed Assayer Master Profiles
    console.log('Seeding assayer master profiles...');
    const assayerRepository = AppDataSource.getRepository(AssayerEntity);
    const assayerPasswordHash = await bcrypt.hash('assayer123', 12);

    const assayersData = [
      {
        code: 'AS-01',
        firstName: 'Nilesh',
        lastName: 'Rahane',
        phone: '+919876543210',
        email: 'nilesh.rahane@fapoms.com',
        address: 'Deccan Gymkhana, Pune',
        state: 'Maharashtra',
        district: 'Pune',
        city: 'Pune City',
        pincode: '411004',
        latitude: 18.5186,
        longitude: 73.8417,
      },
      {
        code: 'AS-02',
        firstName: 'Pooja',
        lastName: 'Kulkarni',
        phone: '+919876543211',
        email: 'pooja.kulkarni@fapoms.com',
        address: 'Colaba Causeway, Mumbai',
        state: 'Maharashtra',
        district: 'Mumbai',
        city: 'Mumbai City',
        pincode: '400005',
        latitude: 18.9186,
        longitude: 72.8282,
      },
      {
        code: 'AS-03',
        firstName: 'Vikram',
        lastName: 'Joshi',
        phone: '+919876543212',
        email: 'vikram.joshi@fapoms.com',
        address: 'Indiranagar, Bangalore',
        state: 'Karnataka',
        district: 'Bangalore Urban',
        city: 'Bangalore',
        pincode: '560038',
        latitude: 12.9719,
        longitude: 77.6412,
      },
      {
        code: 'AS-04',
        firstName: 'Aditya',
        lastName: 'Sharma',
        phone: '+919876543213',
        email: 'aditya.sharma@fapoms.com',
        address: 'Kothrud, Pune',
        state: 'Maharashtra',
        district: 'Pune',
        city: 'Pune City',
        pincode: '411038',
        latitude: 18.5074,
        longitude: 73.8077,
      },
      {
        code: 'AS-05',
        firstName: 'Amit',
        lastName: 'Deshpande',
        phone: '+919876543214',
        email: 'amit.deshpande@fapoms.com',
        address: 'Hadapsar, Pune',
        state: 'Maharashtra',
        district: 'Pune',
        city: 'Pune City',
        pincode: '411028',
        latitude: 18.5089,
        longitude: 73.9260,
      },
      {
        code: 'AS-06',
        firstName: 'Sneha',
        lastName: 'Patil',
        phone: '+919876543215',
        email: 'sneha.patil@fapoms.com',
        address: 'Hinjewadi, Pune',
        state: 'Maharashtra',
        district: 'Pune',
        city: 'Pune City',
        pincode: '411057',
        latitude: 18.5912,
        longitude: 73.7388,
      },
      {
        code: 'AS-07',
        firstName: 'Rajesh',
        lastName: 'Gupta',
        phone: '+919876543216',
        email: 'rajesh.gupta@fapoms.com',
        address: 'Nashik Road, Nashik',
        state: 'Maharashtra',
        district: 'Nashik',
        city: 'Nashik',
        pincode: '422101',
        latitude: 19.9975,
        longitude: 73.7898,
      },
      {
        code: 'AS-08',
        firstName: 'Deepak',
        lastName: 'Verma',
        phone: '+919876543217',
        email: 'deepak.verma@fapoms.com',
        address: 'Connaught Place, Delhi',
        state: 'Delhi',
        district: 'Central Delhi',
        city: 'New Delhi',
        pincode: '110001',
        latitude: 28.6315,
        longitude: 77.2167,
      },
    ];

    // Per-assayer skill/cert differentiation for realistic filtering
    const assayerDetailsMap: Record<string, { emergencyContactName: string; emergencyContactPhone: string; emergencyContactRelation: string; languages: string[]; panNumber?: string }> = {
      'AS-01': { emergencyContactName: 'Sneha Rahane', emergencyContactPhone: '+919876543210', emergencyContactRelation: 'Spouse', languages: ['Marathi', 'Hindi', 'English'], panNumber: 'ABCPR1234H' },
      'AS-02': { emergencyContactName: 'Rajesh Kulkarni', emergencyContactPhone: '+919876543211', emergencyContactRelation: 'Father', languages: ['Marathi', 'Hindi', 'English'], panNumber: 'DEFPR5678I' },
      'AS-03': { emergencyContactName: 'Anita Joshi', emergencyContactPhone: '+919876543212', emergencyContactRelation: 'Spouse', languages: ['Kannada', 'Hindi', 'English'], panNumber: 'GHIPR9012J' },
      'AS-04': { emergencyContactName: 'Sunita Sharma', emergencyContactPhone: '+919876543213', emergencyContactRelation: 'Mother', languages: ['Marathi', 'Hindi', 'English'], panNumber: 'JKLPR3456K' },
      'AS-05': { emergencyContactName: 'Priya Deshpande', emergencyContactPhone: '+919876543214', emergencyContactRelation: 'Spouse', languages: ['Marathi', 'Hindi'], panNumber: 'MNOPR7890L' },
      'AS-06': { emergencyContactName: 'Anil Patil', emergencyContactPhone: '+919876543215', emergencyContactRelation: 'Father', languages: ['Marathi', 'Hindi', 'English'] },
      'AS-07': { emergencyContactName: 'Meena Gupta', emergencyContactPhone: '+919876543216', emergencyContactRelation: 'Spouse', languages: ['Hindi', 'English'], panNumber: 'PQRST2345M' },
      'AS-08': { emergencyContactName: 'Suresh Verma', emergencyContactPhone: '+919876543217', emergencyContactRelation: 'Father', languages: ['Hindi', 'English', 'Punjabi'], panNumber: 'STUVW6789N' },
    };

    const assayerSkillsMap: Record<string, { skills: string[]; certifications: { name: string; expiryDate: string }[]; experienceYears: number; performanceRating: number }> = {
      'AS-01': {
        skills: ['Gold', 'Gold Valuation', 'Financial Auditing', 'Agricultural Audit'],
        certifications: [
          { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' },
          { name: 'Gold Valuation Specialist', expiryDate: '2028-12-31' },
        ],
        experienceYears: 8,
        performanceRating: 4.8,
      },
      'AS-02': {
        skills: ['Gold', 'Gold Valuation', 'Financial Auditing'],
        certifications: [
          { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' },
          { name: 'Gold Valuation Specialist', expiryDate: '2028-12-31' },
        ],
        experienceYears: 6,
        performanceRating: 4.5,
      },
      'AS-03': {
        skills: ['Gold', 'Gold Valuation'],
        certifications: [
          { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' },
        ],
        experienceYears: 4,
        performanceRating: 4.2,
      },
      'AS-04': {
        skills: ['Gold', 'Gold Valuation', 'Agricultural Audit'],
        certifications: [
          { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' },
          { name: 'Gold Valuation Specialist', expiryDate: '2028-12-31' },
        ],
        experienceYears: 7,
        performanceRating: 4.6,
      },
      'AS-05': {
        skills: ['Gold', 'Gold Valuation', 'Financial Auditing'],
        certifications: [
          { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' },
        ],
        experienceYears: 5,
        performanceRating: 4.3,
      },
      'AS-06': {
        // Missing 'Certified Gold Assayer' — will be filtered out by SBI's requiredCertifications
        skills: ['Gold', 'Gold Valuation', 'Financial Auditing'],
        certifications: [
          { name: 'Gold Valuation Specialist', expiryDate: '2028-12-31' },
        ],
        experienceYears: 3,
        performanceRating: 3.9,
      },
      'AS-07': {
        skills: ['Gold', 'Gold Valuation'],
        certifications: [
          { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' },
          { name: 'Gold Valuation Specialist', expiryDate: '2028-12-31' },
        ],
        experienceYears: 5,
        performanceRating: 4.1,
      },
      'AS-08': {
        // Has everything but is in Delhi — distance filter will handle
        skills: ['Gold', 'Gold Valuation', 'Financial Auditing', 'Agricultural Audit'],
        certifications: [
          { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' },
          { name: 'Gold Valuation Specialist', expiryDate: '2028-12-31' },
        ],
        experienceYears: 10,
        performanceRating: 4.9,
      },
    };

    for (const ad of assayersData) {
      let assayer = await assayerRepository.findOne({ where: { assayerCode: ad.code } });
      if (!assayer) {
        assayer = assayerRepository.create({
          assayerCode: ad.code,
          passwordHash: assayerPasswordHash,
          firstName: ad.firstName,
          lastName: ad.lastName,
          displayName: `${ad.firstName} ${ad.lastName}`,
          phone: ad.phone,
          email: ad.email,
          address: ad.address,
          state: ad.state,
          district: ad.district,
          city: ad.city,
          pincode: ad.pincode,
          latitude: ad.latitude,
          longitude: ad.longitude,
          location: { type: 'Point', coordinates: [ad.longitude, ad.latitude] },
          status: AssayerStatus.ACTIVE,
          lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
          experienceYears: assayerSkillsMap[ad.code]?.experienceYears || 3,
          performanceRating: assayerSkillsMap[ad.code]?.performanceRating || 4.0,
          organizationId: defaultOrg.id,
          createdBy: 'system',
          updatedBy: 'system',
        });
        await assayerRepository.save(assayer);

        const attrRepo = AppDataSource.getRepository(WorkforceAttributeEntity);
        const attrs: Partial<WorkforceAttributeEntity>[] = [];
        const skills = assayerSkillsMap[ad.code]?.skills || ['Gold', 'Gold Valuation'];
        for (const skill of skills) {
          attrs.push({ assayerId: assayer.id, type: 'SKILL', name: skill, createdBy: 'system', updatedBy: 'system' });
        }
        const certs = assayerSkillsMap[ad.code]?.certifications || [];
        for (const cert of certs) {
          attrs.push({
            assayerId: assayer.id, type: 'CERTIFICATION', name: cert.name,
            expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null,
            createdBy: 'system', updatedBy: 'system',
          });
        }
        const details = assayerDetailsMap[ad.code];
        if (details) {
          if (details.languages.length > 0) {
            const langAttrs = details.languages.map(lang => ({ assayerId: assayer!.id, type: 'LANGUAGE', name: lang, createdBy: 'system', updatedBy: 'system' }));
            attrs.push(...langAttrs);
          }
          assayer.emergencyContactName = details.emergencyContactName;
          assayer.emergencyContactPhone = details.emergencyContactPhone;
          assayer.emergencyContactRelation = details.emergencyContactRelation;
          if (details.panNumber) assayer.panNumber = details.panNumber;
        }

        if (attrs.length > 0) await attrRepo.save(attrs);
        await assayerRepository.save(assayer);

        console.log(`Seeded assayer: ${assayer.displayName} (${ad.code})`);
      }
    }

    // 10.5 Seed Commercial Profiles
    console.log('Seeding commercial profiles...');
    const commercialRepo = AppDataSource.getRepository(AssayerCommercialProfileEntity);
    const allAssayers = await assayerRepository.find();
    const feeBands: Record<string, { baseFee: number; dailyRate: number }> = {
      'AS-01': { baseFee: 1800, dailyRate: 4500 },
      'AS-02': { baseFee: 1600, dailyRate: 4000 },
      'AS-03': { baseFee: 1500, dailyRate: 3800 },
      'AS-04': { baseFee: 1700, dailyRate: 4200 },
      'AS-05': { baseFee: 1550, dailyRate: 3900 },
      'AS-06': { baseFee: 1400, dailyRate: 3600 },
      'AS-07': { baseFee: 1500, dailyRate: 3750 },
      'AS-08': { baseFee: 2000, dailyRate: 5000 },
    };
    for (const a of allAssayers) {
      const existing = await commercialRepo.findOne({ where: { assayerId: a.id } });
      if (!existing) {
        const band = feeBands[a.assayerCode] || { baseFee: 1500, dailyRate: 3500 };
        await commercialRepo.save(commercialRepo.create({
          assayerId: a.id,
          baseFee: band.baseFee,
          dailyRate: band.dailyRate,
          hourlyRate: 0,
          travelReimbursement: 500,
          accommodationAllowance: 1000,
          mealAllowance: 300,
          currency: 'INR',
          effectiveStartDate: new Date('2026-01-01'),
          createdBy: 'system',
          updatedBy: 'system',
        }));
      }
    }
    console.log(`Seeded commercial profiles for ${allAssayers.length} assayers`);

    // 11. Seed Initial Branches
    console.log('Seeding initial branches...');
    const branchRepository = AppDataSource.getRepository(BranchEntity);
    const branchContactRepository = AppDataSource.getRepository(BranchContactEntity);
    const sbiClient = await clientRepository.findOne({ where: { clientCode: 'SBI' } });

    if (sbiClient) {
      const branchesData = [
        {
          solId: '1029',
          name: 'Pune Main Branch',
          address: '123 Shivaji Road, Deccan, Pune',
          state: 'Maharashtra',
          district: 'Pune',
          city: 'Pune City',
          pincode: '411001',
          latitude: 18.5204,
          longitude: 73.8567,
          region: 'West',
          territory: 'Maharashtra West',
          branchType: 'MAIN',
          riskScore: 2.5,
          riskCategory: 'MEDIUM',
          complexity: 'STANDARD',
          estimatedDurationHours: 8.0,
          phone: '+912012345678',
          email: 'pune.main@sbi.co.in',
          managerName: 'Rajesh Patil',
          contacts: [
            { name: 'Rajesh Patil', email: 'rajesh.patil@sbi.co.in', phone: '+912012345678', designation: 'Branch Manager', department: 'Management', isPrimary: true },
            { name: 'Sneha Deshmukh', email: 'sneha.deshmukh@sbi.co.in', phone: '+912012345679', designation: 'Operations Head', department: 'Operations', isPrimary: false },
          ],
        },
        {
          solId: '1105',
          name: 'Mumbai Fort Branch',
          address: '789 Fort Chambers, Fort, Mumbai',
          state: 'Maharashtra',
          district: 'Mumbai',
          city: 'Mumbai City',
          pincode: '400001',
          latitude: 18.9696,
          longitude: 72.8240,
          region: 'West',
          territory: 'Mumbai Metro',
          branchType: 'MAIN',
          riskScore: 3.0,
          riskCategory: 'MEDIUM',
          complexity: 'COMPLEX',
          estimatedDurationHours: 10.0,
          phone: '+912212345678',
          email: 'mumbai.fort@sbi.co.in',
          managerName: 'Vikram Mehta',
          contacts: [
            { name: 'Vikram Mehta', email: 'vikram.mehta@sbi.co.in', phone: '+912212345678', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '3049',
          name: 'Bangalore MG Road',
          address: '202 Mahatma Gandhi Road, Bangalore',
          state: 'Karnataka',
          district: 'Bangalore Urban',
          city: 'Bangalore',
          pincode: '560001',
          latitude: 12.9716,
          longitude: 77.5946,
          region: 'South',
          territory: 'Karnataka South',
          branchType: 'MAIN',
          riskScore: 2.0,
          riskCategory: 'LOW',
          complexity: 'STANDARD',
          estimatedDurationHours: 7.0,
          phone: '+918012345678',
          email: 'bangalore.mgroad@sbi.co.in',
          managerName: 'Ananya Rao',
          contacts: [
            { name: 'Ananya Rao', email: 'ananya.rao@sbi.co.in', phone: '+918012345678', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '1035',
          name: 'Pune Aundh Branch',
          address: '45 Aundh Road, Pune',
          state: 'Maharashtra',
          district: 'Pune',
          city: 'Pune City',
          pincode: '411007',
          latitude: 18.5580,
          longitude: 73.8075,
          region: 'West',
          territory: 'Maharashtra West',
          branchType: 'SUB',
          riskScore: 1.5,
          riskCategory: 'LOW',
          complexity: 'STANDARD',
          estimatedDurationHours: 4.0,
          phone: '+912012345680',
          email: 'pune.aundh@sbi.co.in',
          managerName: 'Sanjay Deshpande',
          contacts: [
            { name: 'Sanjay Deshpande', email: 'sanjay.deshpande@sbi.co.in', phone: '+912012345680', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '1036',
          name: 'Pune Yerwada Branch',
          address: '89 Yerwada Central, Pune',
          state: 'Maharashtra',
          district: 'Pune',
          city: 'Pune City',
          pincode: '411006',
          latitude: 18.5529,
          longitude: 73.8796,
          region: 'West',
          territory: 'Maharashtra West',
          branchType: 'SUB',
          riskScore: 2.0,
          riskCategory: 'LOW',
          complexity: 'STANDARD',
          estimatedDurationHours: 4.0,
          phone: '+912012345681',
          email: 'pune.yerwada@sbi.co.in',
          managerName: 'Karan Malhotra',
          contacts: [
            { name: 'Karan Malhotra', email: 'karan.malhotra@sbi.co.in', phone: '+912012345681', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '1037',
          name: 'Pune Hinjewadi Branch',
          address: '12 Rajiv Gandhi IT Park, Hinjewadi, Pune',
          state: 'Maharashtra',
          district: 'Pune',
          city: 'Pune City',
          pincode: '411057',
          latitude: 18.5912,
          longitude: 73.7389,
          region: 'West',
          territory: 'Maharashtra West',
          branchType: 'SUB',
          riskScore: 1.0,
          riskCategory: 'LOW',
          complexity: 'SIMPLE',
          estimatedDurationHours: 3.0,
          phone: '+912012345682',
          email: 'pune.hinjewadi@sbi.co.in',
          managerName: 'Priya Sawant',
          contacts: [
            { name: 'Priya Sawant', email: 'priya.sawant@sbi.co.in', phone: '+912012345682', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '1038',
          name: 'Pune Koregaon Park Branch',
          address: '77 North Main Road, Koregaon Park, Pune',
          state: 'Maharashtra',
          district: 'Pune',
          city: 'Pune City',
          pincode: '411001',
          latitude: 18.5362,
          longitude: 73.8930,
          region: 'West',
          territory: 'Maharashtra West',
          branchType: 'SUB',
          riskScore: 1.5,
          riskCategory: 'LOW',
          complexity: 'STANDARD',
          estimatedDurationHours: 3.5,
          phone: '+912012345683',
          email: 'pune.koregaon@sbi.co.in',
          managerName: 'Anil Kale',
          contacts: [
            { name: 'Anil Kale', email: 'anil.kale@sbi.co.in', phone: '+912012345683', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '2001',
          name: 'Nashik Main Branch',
          address: '9 MG Road, Nashik',
          state: 'Maharashtra',
          district: 'Nashik',
          city: 'Nashik',
          pincode: '422001',
          latitude: 20.0063,
          longitude: 73.7902,
          region: 'West',
          territory: 'Maharashtra North',
          branchType: 'MAIN',
          riskScore: 2.5,
          riskCategory: 'MEDIUM',
          complexity: 'STANDARD',
          estimatedDurationHours: 5.0,
          phone: '+912532345678',
          email: 'nashik.main@sbi.co.in',
          managerName: 'Sandeep Bhosale',
          contacts: [
            { name: 'Sandeep Bhosale', email: 'sandeep.bhosale@sbi.co.in', phone: '+912532345678', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '2002',
          name: 'Nashik Gangapur Road Branch',
          address: '45 Gangapur Road, Nashik',
          state: 'Maharashtra',
          district: 'Nashik',
          city: 'Nashik',
          pincode: '422005',
          latitude: 20.0140,
          longitude: 73.7700,
          region: 'West',
          territory: 'Maharashtra North',
          branchType: 'SUB',
          riskScore: 1.5,
          riskCategory: 'LOW',
          complexity: 'SIMPLE',
          estimatedDurationHours: 3.0,
          phone: '+912532345679',
          email: 'nashik.gangapur@sbi.co.in',
          managerName: 'Meera Jadhav',
          contacts: [
            { name: 'Meera Jadhav', email: 'meera.jadhav@sbi.co.in', phone: '+912532345679', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
        {
          solId: '2501',
          name: 'Nagpur Sitabuldi Branch',
          address: '101 Sitabuldi Road, Nagpur',
          state: 'Maharashtra',
          district: 'Nagpur',
          city: 'Nagpur',
          pincode: '440012',
          latitude: 21.1458,
          longitude: 79.0882,
          region: 'Central',
          territory: 'Maharashtra Central',
          branchType: 'MAIN',
          riskScore: 3.0,
          riskCategory: 'MEDIUM',
          complexity: 'COMPLEX',
          estimatedDurationHours: 6.0,
          phone: '+917122345678',
          email: 'nagpur.sitabuldi@sbi.co.in',
          managerName: 'Vivek Shinde',
          contacts: [
            { name: 'Vivek Shinde', email: 'vivek.shinde@sbi.co.in', phone: '+917122345678', designation: 'Branch Manager', department: 'Management', isPrimary: true },
          ],
        },
      ];

      const seededBranches: BranchEntity[] = [];
      for (const bd of branchesData) {
        let branch = await branchRepository.findOne({ where: { solId: bd.solId } });
        if (!branch) {
          branch = branchRepository.create({
            clientId: sbiClient.id,
            solId: bd.solId,
            name: bd.name,
            address: bd.address,
            state: bd.state,
            district: bd.district,
            city: bd.city,
            pincode: bd.pincode,
            latitude: bd.latitude,
            longitude: bd.longitude,
            location: { type: 'Point', coordinates: [bd.longitude, bd.latitude] },
            region: bd.region,
            territory: bd.territory,
            branchType: bd.branchType,
            riskScore: bd.riskScore,
            riskCategory: bd.riskCategory,
            complexity: bd.complexity,
            estimatedDurationHours: bd.estimatedDurationHours,
            phone: bd.phone,
            email: bd.email,
            managerName: bd.managerName,
            createdBy: 'system',
            updatedBy: 'system',
          });
          branch = await branchRepository.save(branch);
          console.log(`Seeded branch: ${branch.name} (${bd.solId})`);

          // Seed contacts
          for (const c of bd.contacts) {
            const existingContact = await branchContactRepository.findOne({ where: { branchId: branch.id, email: c.email } });
            if (!existingContact) {
              const contact = branchContactRepository.create({
                branchId: branch.id,
                name: c.name,
                email: c.email,
                phone: c.phone,
                designation: c.designation,
                department: c.department,
                isPrimary: c.isPrimary,
                createdBy: 'system',
                updatedBy: 'system',
              });
              await branchContactRepository.save(contact);
            }
          }
        }
        seededBranches.push(branch);
      }

      // 12. Seed Default Project
      console.log('Seeding default project...');
      const projectRepository = AppDataSource.getRepository(ProjectEntity);
      let project = await projectRepository.findOne({ where: { projectNumber: 'PRJ-2026-001' } });
      if (!project) {
        project = projectRepository.create({
          projectNumber: 'PRJ-2026-001',
          name: 'SBI Corporate Audit 2026',
          description: 'Annual corporate reference audit for State Bank of India branches.',
          clientId: sbiClient.id,
          status: ProjectStatus.PLANNING,
          priority: Priority.HIGH,
          startDate: new Date('2026-07-01'),
          endDate: new Date('2026-07-31'),
          createdBy: 'system',
          updatedBy: 'system',
        });
        project = await projectRepository.save(project);
        console.log(`Seeded project: ${project.name}`);
      }

      // 13. Seed Project Branches
      console.log('Seeding project branches...');
      const projectBranchRepository = AppDataSource.getRepository(ProjectBranchEntity);
      for (const sb of seededBranches) {
        let pb = await projectBranchRepository.findOne({ where: { projectId: project.id, branchId: sb.id } });
        if (!pb) {
          pb = projectBranchRepository.create({
            projectId: project.id,
            branchId: sb.id,
            status: ProjectBranchStatus.PLANNING,
            priority: Priority.HIGH,
            createdBy: 'system',
            updatedBy: 'system',
          });
          await projectBranchRepository.save(pb);
          console.log(`Seeded project branch link for: ${sb.name}`);
        }
      }
    }

    // 14. Seed Holiday Calendar
    console.log('Seeding holiday calendar...');
    const holidayRepository = AppDataSource.getRepository(HolidayEntity);
    const holidaysData = [
      { name: 'Republic Day', date: new Date('2026-01-26'), type: 'NATIONAL', states: null },
      { name: 'Holi', date: new Date('2026-03-04'), type: 'BANK', states: null },
      { name: 'Good Friday', date: new Date('2026-04-03'), type: 'BANK', states: null },
      { name: 'Dr. Ambedkar Jayanti', date: new Date('2026-04-14'), type: 'NATIONAL', states: null },
      { name: 'Maharashtra Day', date: new Date('2026-05-01'), type: 'STATE', states: ['Maharashtra'] },
      { name: 'Id-ul-Fitr', date: new Date('2026-03-20'), type: 'BANK', states: null },
      { name: 'Bakrid / Eid al-Adha', date: new Date('2026-05-27'), type: 'BANK', states: null },
      { name: 'Independence Day', date: new Date('2026-08-15'), type: 'NATIONAL', states: null },
      { name: 'Ganesh Chaturthi', date: new Date('2026-09-14'), type: 'STATE', states: ['Maharashtra', 'Gujarat', 'Karnataka'] },
      { name: 'Mahatma Gandhi Jayanti', date: new Date('2026-10-02'), type: 'NATIONAL', states: null },
      { name: 'Dussehra / Vijayadashami', date: new Date('2026-10-20'), type: 'BANK', states: null },
      { name: 'Diwali (Laxmi Pujan)', date: new Date('2026-11-08'), type: 'NATIONAL', states: null },
      { name: 'Guru Nanak Jayanti', date: new Date('2026-11-24'), type: 'BANK', states: null },
      { name: 'Christmas Day', date: new Date('2026-12-25'), type: 'NATIONAL', states: null },
    ];

    for (const hd of holidaysData) {
      let holiday = await holidayRepository.findOne({ where: { name: hd.name, year: hd.date.getFullYear() } });
      if (!holiday) {
        holiday = holidayRepository.create({
          name: hd.name,
          date: hd.date,
          type: hd.type,
          applicableStates: hd.states,
          year: hd.date.getFullYear(),
          createdBy: 'system',
          updatedBy: 'system',
        });
        await holidayRepository.save(holiday);
        console.log(`Seeded holiday: ${holiday.name} (${hd.date.toISOString().split('T')[0]})`);
      }
    }

    // 15. Seed Validation Queue Cases
    console.log('Seeding validation cases...');
    const validationRepo = AppDataSource.getRepository(ValidationCaseEntity);
    const pbRepo = AppDataSource.getRepository(ProjectBranchEntity);
    const branches = await pbRepo.find();
    for (const b of branches) {
      const existing = await validationRepo.findOne({ where: { projectBranchId: b.id } });
      if (!existing) {
        await validationRepo.save(
          validationRepo.create({
            projectBranchId: b.id,
            status: ValidationStatus.PENDING,
            remarks: 'Auto-seeded for Data Entry Review',
            createdBy: 'system',
            updatedBy: 'system',
          })
        );
        console.log(`Seeded validation case for project branch ${b.id}`);
      }
    }

    console.log('Seeding completed successfully!');
  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    await AppDataSource.destroy();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
