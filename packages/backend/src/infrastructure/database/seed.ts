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
import { BranchEntity } from '../../modules/branch/branch.entity';
import { BranchContactEntity } from '../../modules/branch/branch-contact.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { ProjectBranchEntity } from '../../modules/project/project-branch.entity';
import { HolidayEntity } from '../../modules/holiday/holiday.entity';
import { SystemRole, PermissionResource, PermissionAction, AuthorizationScope, UserStatus, AssayerLifecycleStatus } from '@fapoms/shared';
import * as bcrypt from 'bcrypt';

async function seed() {
  console.log('Starting database seeding...');
  await AppDataSource.initialize();
  console.log('Database connection initialized.');

  try {
    // Clean slate: Truncate existing tables to resolve potential database corruption
    console.log('Truncating existing tables for clean seed...');
    await AppDataSource.query('TRUNCATE TABLE capabilities, capability_permissions, responsibilities, responsibility_capabilities, role_responsibilities, users, roles, permissions, organizations, clients, client_configurations, client_contacts, client_contracts, client_billing, assayers, assayer_government_documents, assayer_documents, assayer_remarks, assayer_activities, branches, branch_contacts, branch_documents, zones, projects, project_branches, assignments CASCADE;');

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

      // Branches
      { resource: PermissionResource.BRANCH, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View all branches' },
      { resource: PermissionResource.BRANCH, action: PermissionAction.IMPORT, scope: AuthorizationScope.ORGANIZATION, description: 'Import branches' },
      { resource: PermissionResource.BRANCH, action: PermissionAction.EDIT, scope: AuthorizationScope.ORGANIZATION, description: 'Edit branches' },

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
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.UPLOAD, scope: AuthorizationScope.ORGANIZATION, description: 'Upload documents' },
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.GENERATE, scope: AuthorizationScope.ORGANIZATION, description: 'Generate documents' },
      { resource: PermissionResource.DOCUMENT, action: PermissionAction.DOWNLOAD, scope: AuthorizationScope.PLATFORM, description: 'Download all documents' },

      // Validation
      { resource: PermissionResource.VALIDATION, action: PermissionAction.ASSIGN, scope: AuthorizationScope.ORGANIZATION, description: 'Assign validation cases' },
      { resource: PermissionResource.VALIDATION, action: PermissionAction.REVIEW, scope: AuthorizationScope.ASSIGNED_RECORDS, description: 'Review assigned validation cases' },
      { resource: PermissionResource.VALIDATION, action: PermissionAction.APPROVE, scope: AuthorizationScope.ORGANIZATION, description: 'Approve validations' },

      // Administration
      { resource: PermissionResource.USER, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View users' },
      { resource: PermissionResource.USER, action: PermissionAction.CREATE, scope: AuthorizationScope.PLATFORM, description: 'Create users' },
      { resource: PermissionResource.USER, action: PermissionAction.EDIT, scope: AuthorizationScope.PLATFORM, description: 'Edit users' },
      { resource: PermissionResource.CONFIGURATION, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View system configuration' },
      { resource: PermissionResource.CONFIGURATION, action: PermissionAction.EDIT, scope: AuthorizationScope.PLATFORM, description: 'Edit system configuration' },
      { resource: PermissionResource.AUDIT_LOG, action: PermissionAction.VIEW, scope: AuthorizationScope.PLATFORM, description: 'View audit logs' },
    ];

    for (const dp of defaultPermissions) {
      let existing = existingPermissions.find(p => p.resource === dp.resource && p.action === dp.action && p.scope === dp.scope);
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
    
    const roleDefinitions = [
      {
        name: SystemRole.SUPER_ADMINISTRATOR,
        displayName: 'Super Administrator',
        description: 'Unlimited access to all platform features and configuration.',
        permissionKeys: Array.from(permissionMap.keys()), // All permissions
        responsibilityNames: Array.from(responsibilityMap.keys()), // All responsibilities
      },
      {
        name: SystemRole.OPERATIONS_MANAGER,
        displayName: 'Operations Manager',
        description: 'Manages projects, assignment planning, schedules, and assayers.',
        permissionKeys: [
          'PROJECT:VIEW:PLATFORM', 'PROJECT:CREATE:ORGANIZATION', 'PROJECT:EDIT:ORGANIZATION', 'PROJECT:ARCHIVE:ORGANIZATION', 'PROJECT:CLOSE:ORGANIZATION',
          'BRANCH:VIEW:PLATFORM', 'BRANCH:IMPORT:ORGANIZATION', 'BRANCH:EDIT:ORGANIZATION',
          'ASSIGNMENT:VIEW:PLATFORM', 'ASSIGNMENT:CREATE:ORGANIZATION', 'ASSIGNMENT:NEGOTIATE:ORGANIZATION', 'ASSIGNMENT:CANCEL:ORGANIZATION',
          'SCHEDULING:VIEW:PLATFORM', 'SCHEDULING:CREATE:ORGANIZATION', 'SCHEDULING:MODIFY:ORGANIZATION',
          'DOCUMENT:UPLOAD:ORGANIZATION', 'DOCUMENT:GENERATE:ORGANIZATION', 'DOCUMENT:DOWNLOAD:PLATFORM',
        ],
        responsibilityNames: ['PROJECT_MANAGEMENT', 'BRANCH_MANAGEMENT', 'ASSIGNMENT_MANAGEMENT', 'SCHEDULE_MANAGEMENT', 'DOCUMENT_MANAGEMENT'],
      },
      {
        name: SystemRole.OPERATIONS_EXECUTIVE,
        displayName: 'Operations Executive',
        description: 'Day to day assayer communication, negotiation logging, and scheduling.',
        permissionKeys: [
          'PROJECT:VIEW:PLATFORM',
          'BRANCH:VIEW:PLATFORM',
          'ASSIGNMENT:VIEW:PLATFORM', 'ASSIGNMENT:NEGOTIATE:ORGANIZATION',
          'SCHEDULING:VIEW:PLATFORM', 'SCHEDULING:CREATE:ORGANIZATION', 'SCHEDULING:MODIFY:ORGANIZATION',
          'DOCUMENT:DOWNLOAD:PLATFORM',
        ],
        responsibilityNames: ['PROJECT_VIEWING', 'BRANCH_VIEWING', 'ASSIGNMENT_VIEWING', 'ASSIGNMENT_MANAGEMENT', 'SCHEDULE_MANAGEMENT', 'DOCUMENT_ACCESS'],
      },
      {
        name: SystemRole.VALIDATOR,
        displayName: 'Validator',
        description: 'Performs OCR manual review and corrections.',
        permissionKeys: [
          'PROJECT:VIEW:PLATFORM',
          'VALIDATION:REVIEW:ASSIGNED_RECORDS',
          'DOCUMENT:DOWNLOAD:PLATFORM',
        ],
        responsibilityNames: ['PROJECT_VIEWING', 'VALIDATION_REVIEWING', 'DOCUMENT_ACCESS'],
      },
    ];

    const rolesMap = new Map<SystemRole, RoleEntity>();

    for (const rd of roleDefinitions) {
      let role = existingRoles.find(r => r.name === rd.name);
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
        role.permissions = rolePermissions;
        role.responsibilities = roleResponsibilities;
      }
      const savedRole = await roleRepository.save(role);
      rolesMap.set(rd.name as SystemRole, savedRole);
    }

    // 7. Seed Users
    console.log('Seeding default users...');
    const userRepository = AppDataSource.getRepository(UserEntity);

    const defaultUsers = [
      { username: 'admin', email: 'admin@fapoms.com', firstName: 'Super', lastName: 'Admin', displayName: 'System Admin', roleName: SystemRole.SUPER_ADMINISTRATOR },
      { username: 'manager', email: 'manager@fapoms.com', firstName: 'Operations', lastName: 'Manager', displayName: 'Ops Manager', roleName: SystemRole.OPERATIONS_MANAGER },
      { username: 'executive', email: 'executive@fapoms.com', firstName: 'Operations', lastName: 'Executive', displayName: 'Ops Executive', roleName: SystemRole.OPERATIONS_EXECUTIVE },
      { username: 'validator', email: 'validator@fapoms.com', firstName: 'Senior', lastName: 'Validator', displayName: 'Senior Validator', roleName: SystemRole.VALIDATOR },
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
      ]},
      { name: 'Gujarat', code: 'GJ', districts: [
        { name: 'Ahmedabad', cities: [{ name: 'Ahmedabad City', pincode: '380001' }] },
        { name: 'Surat', cities: [{ name: 'Surat City', pincode: '395003' }] },
      ]},
      { name: 'Karnataka', code: 'KA', districts: [
        { name: 'Bangalore Urban', cities: [{ name: 'Bangalore', pincode: '560001' }] },
      ]}
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
          branchCode: 'Branch Code',
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
          branchCode: 'BrCode',
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
    ];

    for (const ad of assayersData) {
      let assayer = await assayerRepository.findOne({ where: { assayerCode: ad.code } });
      if (!assayer) {
        assayer = assayerRepository.create({
          assayerCode: ad.code,
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
          status: 'ACTIVE',
          lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
          skills: ['Gold', 'Gold Valuation', 'Agricultural Audit', 'Financial Auditing'],
          certifications: [
            { name: 'Gold Valuation Specialist', expiryDate: '2028-12-31' },
            { name: 'Certified Gold Assayer', expiryDate: '2028-12-31' }
          ],
          organizationId: defaultOrg.id,
          createdBy: 'system',
          updatedBy: 'system',
        });
        await assayerRepository.save(assayer);
        console.log(`Seeded assayer: ${assayer.displayName} (${ad.code})`);
      }
    }

    // 11. Seed Initial Branches
    console.log('Seeding initial branches...');
    const branchRepository = AppDataSource.getRepository(BranchEntity);
    const branchContactRepository = AppDataSource.getRepository(BranchContactEntity);
    const sbiClient = await clientRepository.findOne({ where: { clientCode: 'SBI' } });

    if (sbiClient) {
      const branchesData = [
        {
          branchCode: 'BR-0010',
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
          branchCode: 'BR-0012',
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
          branchCode: 'BR-0030',
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
      ];

      const seededBranches: BranchEntity[] = [];
      for (const bd of branchesData) {
        let branch = await branchRepository.findOne({ where: { branchCode: bd.branchCode } });
        if (!branch) {
          branch = branchRepository.create({
            clientId: sbiClient.id,
            branchCode: bd.branchCode,
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
          console.log(`Seeded branch: ${branch.name} (${bd.branchCode})`);

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
          status: 'PLANNING' as any,
          priority: 'HIGH' as any,
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
            status: 'PLANNING' as any,
            priority: 'HIGH' as any,
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
      { name: 'Independence Day', date: new Date('2026-08-15'), type: 'NATIONAL', states: null },
      { name: 'Maharashtra Day', date: new Date('2026-05-01'), type: 'STATE', states: ['Maharashtra'] },
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

    console.log('Seeding completed successfully!');
  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    await AppDataSource.destroy();
  }
}

seed();
