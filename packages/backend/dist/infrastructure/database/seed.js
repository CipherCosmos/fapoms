"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const data_source_1 = require("./data-source");
const user_entity_1 = require("../../modules/user/user.entity");
const role_entity_1 = require("../../modules/user/role.entity");
const permission_entity_1 = require("../../modules/user/permission.entity");
const capability_entity_1 = require("../../modules/user/capability.entity");
const responsibility_entity_1 = require("../../modules/user/responsibility.entity");
const organization_entity_1 = require("../../modules/organization/organization.entity");
const geo_entities_1 = require("../../modules/geo/geo.entities");
const client_entity_1 = require("../../modules/client/client.entity");
const client_configuration_entity_1 = require("../../modules/client/client-configuration.entity");
const client_contact_entity_1 = require("../../modules/client/client-contact.entity");
const client_billing_entity_1 = require("../../modules/client/client-billing.entity");
const assayer_entity_1 = require("../../modules/assayer/assayer.entity");
const branch_entity_1 = require("../../modules/branch/branch.entity");
const branch_contact_entity_1 = require("../../modules/branch/branch-contact.entity");
const project_entity_1 = require("../../modules/project/project.entity");
const project_branch_entity_1 = require("../../modules/project/project-branch.entity");
const holiday_entity_1 = require("../../modules/holiday/holiday.entity");
const shared_1 = require("@fapoms/shared");
const bcrypt = require("bcrypt");
async function seed() {
    console.log('Starting database seeding...');
    await data_source_1.AppDataSource.initialize();
    console.log('Database connection initialized.');
    try {
        console.log('Truncating existing tables for clean seed...');
        await data_source_1.AppDataSource.query('TRUNCATE TABLE capabilities, capability_permissions, responsibilities, responsibility_capabilities, role_responsibilities, users, roles, permissions, organizations, clients, client_configurations, client_contacts, client_contracts, client_billing, assayers, assayer_government_documents, assayer_documents, assayer_remarks, assayer_activities, branches, branch_contacts, branch_documents, zones, projects, project_branches, assignments CASCADE;');
        console.log('Seeding default organization...');
        const orgRepository = data_source_1.AppDataSource.getRepository(organization_entity_1.OrganizationEntity);
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
        console.log('Seeding permissions...');
        const permissionRepository = data_source_1.AppDataSource.getRepository(permission_entity_1.PermissionEntity);
        const existingPermissions = await permissionRepository.find();
        const permissionsToSeed = [];
        const resources = Object.values(shared_1.PermissionResource);
        const actions = Object.values(shared_1.PermissionAction);
        const scopes = Object.values(shared_1.AuthorizationScope);
        const permissionMap = new Map();
        const defaultPermissions = [
            { resource: shared_1.PermissionResource.PROJECT, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.PLATFORM, description: 'View all projects' },
            { resource: shared_1.PermissionResource.PROJECT, action: shared_1.PermissionAction.CREATE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Create projects within organization' },
            { resource: shared_1.PermissionResource.PROJECT, action: shared_1.PermissionAction.EDIT, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Edit projects within organization' },
            { resource: shared_1.PermissionResource.PROJECT, action: shared_1.PermissionAction.ARCHIVE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Archive projects within organization' },
            { resource: shared_1.PermissionResource.PROJECT, action: shared_1.PermissionAction.CLOSE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Close projects within organization' },
            { resource: shared_1.PermissionResource.BRANCH, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.PLATFORM, description: 'View all branches' },
            { resource: shared_1.PermissionResource.BRANCH, action: shared_1.PermissionAction.IMPORT, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Import branches' },
            { resource: shared_1.PermissionResource.BRANCH, action: shared_1.PermissionAction.EDIT, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Edit branches' },
            { resource: shared_1.PermissionResource.ASSIGNMENT, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.PLATFORM, description: 'View all assignments' },
            { resource: shared_1.PermissionResource.ASSIGNMENT, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.ASSIGNED_RECORDS, description: 'View own assignments' },
            { resource: shared_1.PermissionResource.ASSIGNMENT, action: shared_1.PermissionAction.CREATE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Create assignments' },
            { resource: shared_1.PermissionResource.ASSIGNMENT, action: shared_1.PermissionAction.NEGOTIATE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Negotiate assignments' },
            { resource: shared_1.PermissionResource.ASSIGNMENT, action: shared_1.PermissionAction.ACCEPT, scope: shared_1.AuthorizationScope.SELF, description: 'Accept assigned work (Assayer)' },
            { resource: shared_1.PermissionResource.ASSIGNMENT, action: shared_1.PermissionAction.CANCEL, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Cancel assignments' },
            { resource: shared_1.PermissionResource.SCHEDULING, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.PLATFORM, description: 'View all schedules' },
            { resource: shared_1.PermissionResource.SCHEDULING, action: shared_1.PermissionAction.CREATE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Create schedules' },
            { resource: shared_1.PermissionResource.SCHEDULING, action: shared_1.PermissionAction.MODIFY, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Modify schedules' },
            { resource: shared_1.PermissionResource.DOCUMENT, action: shared_1.PermissionAction.UPLOAD, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Upload documents' },
            { resource: shared_1.PermissionResource.DOCUMENT, action: shared_1.PermissionAction.GENERATE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Generate documents' },
            { resource: shared_1.PermissionResource.DOCUMENT, action: shared_1.PermissionAction.DOWNLOAD, scope: shared_1.AuthorizationScope.PLATFORM, description: 'Download all documents' },
            { resource: shared_1.PermissionResource.VALIDATION, action: shared_1.PermissionAction.ASSIGN, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Assign validation cases' },
            { resource: shared_1.PermissionResource.VALIDATION, action: shared_1.PermissionAction.REVIEW, scope: shared_1.AuthorizationScope.ASSIGNED_RECORDS, description: 'Review assigned validation cases' },
            { resource: shared_1.PermissionResource.VALIDATION, action: shared_1.PermissionAction.APPROVE, scope: shared_1.AuthorizationScope.ORGANIZATION, description: 'Approve validations' },
            { resource: shared_1.PermissionResource.USER, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.PLATFORM, description: 'View users' },
            { resource: shared_1.PermissionResource.USER, action: shared_1.PermissionAction.CREATE, scope: shared_1.AuthorizationScope.PLATFORM, description: 'Create users' },
            { resource: shared_1.PermissionResource.USER, action: shared_1.PermissionAction.EDIT, scope: shared_1.AuthorizationScope.PLATFORM, description: 'Edit users' },
            { resource: shared_1.PermissionResource.CONFIGURATION, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.PLATFORM, description: 'View system configuration' },
            { resource: shared_1.PermissionResource.CONFIGURATION, action: shared_1.PermissionAction.EDIT, scope: shared_1.AuthorizationScope.PLATFORM, description: 'Edit system configuration' },
            { resource: shared_1.PermissionResource.AUDIT_LOG, action: shared_1.PermissionAction.VIEW, scope: shared_1.AuthorizationScope.PLATFORM, description: 'View audit logs' },
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
            }
            else {
                permissionMap.set(`${dp.resource}:${dp.action}:${dp.scope}`, existing);
            }
        }
        console.log('Seeding capabilities...');
        const capabilityRepository = data_source_1.AppDataSource.getRepository(capability_entity_1.CapabilityEntity);
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
        const capabilityMap = new Map();
        for (const cd of capabilityDefinitions) {
            let capability = existingCapabilities.find(c => c.name === cd.name);
            const capPerms = cd.permissionKeys
                .map(key => permissionMap.get(key))
                .filter((p) => !!p);
            if (!capability) {
                capability = capabilityRepository.create({
                    name: cd.name,
                    displayName: cd.displayName,
                    category: cd.category,
                    permissions: capPerms,
                    createdBy: 'system',
                    updatedBy: 'system',
                });
            }
            else {
                capability.permissions = capPerms;
            }
            const saved = await capabilityRepository.save(capability);
            capabilityMap.set(cd.name, saved);
        }
        console.log('Seeding responsibilities...');
        const responsibilityRepository = data_source_1.AppDataSource.getRepository(responsibility_entity_1.ResponsibilityEntity);
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
        const responsibilityMap = new Map();
        for (const rd of responsibilityDefinitions) {
            let responsibility = existingResponsibilities.find(r => r.name === rd.name);
            const respCapabilities = rd.capabilityNames
                .map(name => capabilityMap.get(name))
                .filter((c) => !!c);
            if (!responsibility) {
                responsibility = responsibilityRepository.create({
                    name: rd.name,
                    displayName: rd.displayName,
                    description: rd.description,
                    capabilities: respCapabilities,
                    createdBy: 'system',
                    updatedBy: 'system',
                });
            }
            else {
                responsibility.capabilities = respCapabilities;
            }
            const saved = await responsibilityRepository.save(responsibility);
            responsibilityMap.set(rd.name, saved);
        }
        console.log('Seeding roles...');
        const roleRepository = data_source_1.AppDataSource.getRepository(role_entity_1.RoleEntity);
        const existingRoles = await roleRepository.find();
        const roleDefinitions = [
            {
                name: shared_1.SystemRole.SUPER_ADMINISTRATOR,
                displayName: 'Super Administrator',
                description: 'Unlimited access to all platform features and configuration.',
                permissionKeys: Array.from(permissionMap.keys()),
                responsibilityNames: Array.from(responsibilityMap.keys()),
            },
            {
                name: shared_1.SystemRole.OPERATIONS_MANAGER,
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
                name: shared_1.SystemRole.OPERATIONS_EXECUTIVE,
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
                name: shared_1.SystemRole.VALIDATOR,
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
        const rolesMap = new Map();
        for (const rd of roleDefinitions) {
            let role = existingRoles.find(r => r.name === rd.name);
            const rolePermissions = rd.permissionKeys
                .map(key => permissionMap.get(key))
                .filter((p) => !!p);
            const roleResponsibilities = rd.responsibilityNames
                .map(name => responsibilityMap.get(name))
                .filter((r) => !!r);
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
            }
            else {
                role.permissions = rolePermissions;
                role.responsibilities = roleResponsibilities;
            }
            const savedRole = await roleRepository.save(role);
            rolesMap.set(rd.name, savedRole);
        }
        console.log('Seeding default users...');
        const userRepository = data_source_1.AppDataSource.getRepository(user_entity_1.UserEntity);
        const defaultUsers = [
            { username: 'admin', email: 'admin@fapoms.com', firstName: 'Super', lastName: 'Admin', displayName: 'System Admin', roleName: shared_1.SystemRole.SUPER_ADMINISTRATOR },
            { username: 'manager', email: 'manager@fapoms.com', firstName: 'Operations', lastName: 'Manager', displayName: 'Ops Manager', roleName: shared_1.SystemRole.OPERATIONS_MANAGER },
            { username: 'executive', email: 'executive@fapoms.com', firstName: 'Operations', lastName: 'Executive', displayName: 'Ops Executive', roleName: shared_1.SystemRole.OPERATIONS_EXECUTIVE },
            { username: 'validator', email: 'validator@fapoms.com', firstName: 'Senior', lastName: 'Validator', displayName: 'Senior Validator', roleName: shared_1.SystemRole.VALIDATOR },
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
                    status: shared_1.UserStatus.ACTIVE,
                    createdBy: 'system',
                    updatedBy: 'system',
                    roles: role ? [role] : [],
                });
                await userRepository.save(user);
                console.log(`Created default user: ${du.username} / admin123`);
            }
        }
        console.log('Seeding geographic reference states, districts, and cities...');
        const stateRepository = data_source_1.AppDataSource.getRepository(geo_entities_1.GeoStateEntity);
        const districtRepository = data_source_1.AppDataSource.getRepository(geo_entities_1.GeoDistrictEntity);
        const cityRepository = data_source_1.AppDataSource.getRepository(geo_entities_1.GeoCityEntity);
        const statesData = [
            { name: 'Maharashtra', code: 'MH', districts: [
                    { name: 'Mumbai', cities: [{ name: 'Mumbai City', pincode: '400001' }] },
                    { name: 'Pune', cities: [{ name: 'Pune City', pincode: '411001' }, { name: 'Pimpri-Chinchwad', pincode: '411018' }] },
                ] },
            { name: 'Gujarat', code: 'GJ', districts: [
                    { name: 'Ahmedabad', cities: [{ name: 'Ahmedabad City', pincode: '380001' }] },
                    { name: 'Surat', cities: [{ name: 'Surat City', pincode: '395003' }] },
                ] },
            { name: 'Karnataka', code: 'KA', districts: [
                    { name: 'Bangalore Urban', cities: [{ name: 'Bangalore', pincode: '560001' }] },
                ] }
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
        console.log('Seeding client master profiles and configurations...');
        const clientRepository = data_source_1.AppDataSource.getRepository(client_entity_1.ClientEntity);
        const clientConfigRepository = data_source_1.AppDataSource.getRepository(client_configuration_entity_1.ClientConfigurationEntity);
        const clientContactRepository = data_source_1.AppDataSource.getRepository(client_contact_entity_1.ClientContactEntity);
        const clientBillingRepository = data_source_1.AppDataSource.getRepository(client_billing_entity_1.ClientBillingEntity);
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
        console.log('Seeding assayer master profiles...');
        const assayerRepository = data_source_1.AppDataSource.getRepository(assayer_entity_1.AssayerEntity);
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
                    lifecycleStatus: shared_1.AssayerLifecycleStatus.ACTIVE,
                    organizationId: defaultOrg.id,
                    createdBy: 'system',
                    updatedBy: 'system',
                });
                await assayerRepository.save(assayer);
                console.log(`Seeded assayer: ${assayer.displayName} (${ad.code})`);
            }
        }
        console.log('Seeding initial branches...');
        const branchRepository = data_source_1.AppDataSource.getRepository(branch_entity_1.BranchEntity);
        const branchContactRepository = data_source_1.AppDataSource.getRepository(branch_contact_entity_1.BranchContactEntity);
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
            const seededBranches = [];
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
            console.log('Seeding default project...');
            const projectRepository = data_source_1.AppDataSource.getRepository(project_entity_1.ProjectEntity);
            let project = await projectRepository.findOne({ where: { projectNumber: 'PRJ-2026-001' } });
            if (!project) {
                project = projectRepository.create({
                    projectNumber: 'PRJ-2026-001',
                    name: 'SBI Corporate Audit 2026',
                    description: 'Annual corporate reference audit for State Bank of India branches.',
                    clientId: sbiClient.id,
                    status: 'PLANNING',
                    priority: 'HIGH',
                    startDate: new Date('2026-07-01'),
                    endDate: new Date('2026-07-31'),
                    createdBy: 'system',
                    updatedBy: 'system',
                });
                project = await projectRepository.save(project);
                console.log(`Seeded project: ${project.name}`);
            }
            console.log('Seeding project branches...');
            const projectBranchRepository = data_source_1.AppDataSource.getRepository(project_branch_entity_1.ProjectBranchEntity);
            for (const sb of seededBranches) {
                let pb = await projectBranchRepository.findOne({ where: { projectId: project.id, branchId: sb.id } });
                if (!pb) {
                    pb = projectBranchRepository.create({
                        projectId: project.id,
                        branchId: sb.id,
                        status: 'PLANNING',
                        priority: 'HIGH',
                        createdBy: 'system',
                        updatedBy: 'system',
                    });
                    await projectBranchRepository.save(pb);
                    console.log(`Seeded project branch link for: ${sb.name}`);
                }
            }
        }
        console.log('Seeding holiday calendar...');
        const holidayRepository = data_source_1.AppDataSource.getRepository(holiday_entity_1.HolidayEntity);
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
    }
    catch (error) {
        console.error('Seeding failed:', error);
    }
    finally {
        await data_source_1.AppDataSource.destroy();
    }
}
seed();
//# sourceMappingURL=seed.js.map