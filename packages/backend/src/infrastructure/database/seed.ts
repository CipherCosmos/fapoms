import { AppDataSource } from './data-source';
import { UserEntity } from '../../modules/user/user.entity';
import { RoleEntity } from '../../modules/user/role.entity';
import { PermissionEntity } from '../../modules/user/permission.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../../modules/geo/geo.entities';
import { ClientEntity } from '../../modules/client/client.entity';
import { ClientConfigurationEntity } from '../../modules/client/client-configuration.entity';
import { AssayerEntity } from '../../modules/assayer/assayer.entity';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { ProjectBranchEntity } from '../../modules/project/project-branch.entity';
import { HolidayEntity } from '../../modules/holiday/holiday.entity';
import { SystemRole, PermissionResource, PermissionAction, AuthorizationScope, UserStatus } from '@fapoms/shared';
import * as bcrypt from 'bcrypt';

async function seed() {
  console.log('Starting database seeding...');
  await AppDataSource.initialize();
  console.log('Database connection initialized.');

  try {
    // Clean slate: Truncate existing tables to resolve potential database corruption
    console.log('Truncating existing tables for clean seed...');
    await AppDataSource.query('TRUNCATE TABLE users, roles, permissions, clients, client_configurations, assayers, branches, projects, project_branches, assignments CASCADE;');

    // 1. Seed Permissions
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

    // 2. Seed Roles
    console.log('Seeding roles...');
    const roleRepository = AppDataSource.getRepository(RoleEntity);
    const existingRoles = await roleRepository.find();
    
    const roleDefinitions = [
      {
        name: SystemRole.SUPER_ADMINISTRATOR,
        displayName: 'Super Administrator',
        description: 'Unlimited access to all platform features and configuration.',
        permissionKeys: Array.from(permissionMap.keys()), // All permissions
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
      },
    ];

    const rolesMap = new Map<SystemRole, RoleEntity>();

    for (const rd of roleDefinitions) {
      let role = existingRoles.find(r => r.name === rd.name);
      const rolePermissions = rd.permissionKeys
        .map(key => permissionMap.get(key))
        .filter((p): p is PermissionEntity => !!p);

      if (!role) {
        role = roleRepository.create({
          name: rd.name,
          displayName: rd.displayName,
          description: rd.description,
          permissions: rolePermissions,
          createdBy: 'system',
          updatedBy: 'system',
        });
      } else {
        role.permissions = rolePermissions;
      }
      const savedRole = await roleRepository.save(role);
      rolesMap.set(rd.name as SystemRole, savedRole);
    }

    // 3. Seed Users (Default Super Admin)
    console.log('Seeding super administrator user...');
    const userRepository = AppDataSource.getRepository(UserEntity);
    const existingAdmin = await userRepository.findOne({ where: { username: 'admin' } });

    if (!existingAdmin) {
      const passwordHash = await bcrypt.hash('admin123', 12);
      const adminRole = rolesMap.get(SystemRole.SUPER_ADMINISTRATOR);
      
      const adminUser = userRepository.create({
        username: 'admin',
        email: 'admin@fapoms.com',
        passwordHash,
        firstName: 'Super',
        lastName: 'Admin',
        displayName: 'System Admin',
        status: UserStatus.ACTIVE,
        createdBy: 'system',
        updatedBy: 'system',
        roles: adminRole ? [adminRole] : [],
      });
      await userRepository.save(adminUser);
      console.log('Created default admin user: admin / admin123');
    }

    // 4. Seed Geographic Master Data
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

    // 5. Seed Client Master Profiles
    console.log('Seeding client master profiles and configurations...');
    const clientRepository = AppDataSource.getRepository(ClientEntity);
    const clientConfigRepository = AppDataSource.getRepository(ClientConfigurationEntity);

    const clientsData = [
      {
        code: 'SBI',
        name: 'State Bank of India',
        displayName: 'SBI Corporate',
        contactPerson: 'Ramesh Sharma',
        contactEmail: 'ramesh.sharma@sbi.co.in',
        contactPhone: '+919876543210',
        address: 'SBI Corporate Headquarters, Nariman Point, Mumbai',
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
      },
      {
        code: 'HDFC',
        name: 'HDFC Bank Limited',
        displayName: 'HDFC Audit',
        contactPerson: 'Anjali Verma',
        contactEmail: 'anjali.verma@hdfcbank.com',
        contactPhone: '+919988776655',
        address: 'HDFC Bank House, Senapati Bapat Marg, Lower Parel, Mumbai',
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
      },
    ];

    for (const cd of clientsData) {
      let client = await clientRepository.findOne({ where: { clientCode: cd.code } });
      if (!client) {
        const config = clientConfigRepository.create({
          importMapping: cd.mapping,
          workingDays: [1, 2, 3, 4, 5],
          defaultRadius: 50.0,
          slaRules: { maxAuditsPerMonth: 2, schedulingWindowDays: 14 },
          effectiveFrom: new Date(),
          createdBy: 'system',
          updatedBy: 'system',
        });

        client = clientRepository.create({
          clientCode: cd.code,
          name: cd.name,
          displayName: cd.displayName,
          contactPerson: cd.contactPerson,
          contactEmail: cd.contactEmail,
          contactPhone: cd.contactPhone,
          address: cd.address,
          configuration: config,
          createdBy: 'system',
          updatedBy: 'system',
        });

        await clientRepository.save(client);
        console.log(`Seeded client: ${cd.name} (${cd.code})`);
      }
    }

    // 6. Seed Assayer Master Profiles
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
          createdBy: 'system',
          updatedBy: 'system',
        });
        await assayerRepository.save(assayer);
        console.log(`Seeded assayer: ${assayer.displayName} (${ad.code})`);
      }
    }

    // 7. Seed Initial Branches
    console.log('Seeding initial branches...');
    const branchRepository = AppDataSource.getRepository(BranchEntity);
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
            createdBy: 'system',
            updatedBy: 'system',
          });
          branch = await branchRepository.save(branch);
          console.log(`Seeded branch: ${branch.name} (${bd.branchCode})`);
        }
        seededBranches.push(branch);
      }

      // 8. Seed Default Project
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

      // 9. Seed Project Branches
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

    // 10. Seed Holiday Calendar
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
