"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const data_source_1 = require("./data-source");
const branch_entity_1 = require("../../modules/branch/branch.entity");
const assayer_entity_1 = require("../../modules/assayer/assayer.entity");
const client_entity_1 = require("../../modules/client/client.entity");
const client_configuration_entity_1 = require("../../modules/client/client-configuration.entity");
const organization_entity_1 = require("../../modules/organization/organization.entity");
const zone_entity_1 = require("../../modules/zone/zone.entity");
const shared_1 = require("@fapoms/shared");
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");
const CACHE_FILE = path.join(__dirname, 'geocoding-cache.json');
const DISTRICT_COORDS = {
    'PALAKKAD': { lat: 10.7867, lng: 76.6548 },
    'COIMBATORE': { lat: 11.0168, lng: 76.9558 },
    'SALEM': { lat: 11.6643, lng: 78.1460 },
    'IDUKKI': { lat: 9.9189, lng: 77.1025 },
    'MADURAI': { lat: 9.9252, lng: 78.1198 },
    'DINDIGUL': { lat: 10.3673, lng: 77.9803 },
    'CHENNAI': { lat: 13.0827, lng: 80.2707 },
    'BANGALORE': { lat: 12.9716, lng: 77.5946 },
    'PONDICHERRY': { lat: 11.9416, lng: 79.8083 },
    'TRICHY': { lat: 10.7905, lng: 78.7047 },
    'TIRUCHIRAPPALLI': { lat: 10.7905, lng: 78.7047 },
    'MYSORE': { lat: 12.2958, lng: 76.6394 },
    'DHARWAD': { lat: 15.4589, lng: 75.0078 },
    'VISAKHAPATNAM': { lat: 17.6868, lng: 83.2185 },
    'WARANGAL': { lat: 17.9784, lng: 79.5941 },
    'KARIMNAGAR': { lat: 18.4386, lng: 79.1288 },
    'KHAMMAM': { lat: 17.2473, lng: 80.1514 },
    'RANGAREDDY': { lat: 17.3616, lng: 78.4747 },
    'K V RANGAREDDY': { lat: 17.3616, lng: 78.4747 },
    'CUTTACK': { lat: 20.4625, lng: 85.8830 },
    'JAJPUR': { lat: 20.8522, lng: 86.3262 },
    'TIRUPATI': { lat: 13.6288, lng: 79.4192 },
    'NELLORE': { lat: 14.4426, lng: 79.9865 },
    'GANJAM': { lat: 19.3800, lng: 85.0600 },
    'PUNE': { lat: 18.5204, lng: 73.8567 },
    'NOIDA': { lat: 28.5355, lng: 77.3910 },
    'NAGPUR': { lat: 21.1458, lng: 79.0882 },
    'SANGLI': { lat: 16.8524, lng: 74.5815 },
    'JHUNJHUNU': { lat: 28.1300, lng: 75.4000 },
    'CALICUT': { lat: 11.2588, lng: 75.7804 },
    'NAMAKKAL': { lat: 11.2189, lng: 78.1674 },
    'TIRUNELVELI': { lat: 8.7139, lng: 77.7567 },
    'TIRUVANNAMALAI': { lat: 12.2253, lng: 79.0747 },
    'TIRUPPUR': { lat: 11.1085, lng: 77.3411 },
    'BIJAPUR': { lat: 16.8302, lng: 75.7100 },
    'VIZIANAGARAM': { lat: 18.1067, lng: 83.3956 },
    'VIJAYAWADA': { lat: 16.5062, lng: 80.6480 },
    'CHITTOOR': { lat: 13.2161, lng: 79.1003 },
    'DHENKANAL': { lat: 20.6628, lng: 85.5976 },
    'BHUVANESHWAR': { lat: 20.2961, lng: 85.8245 },
    'KOLHAPUR': { lat: 16.7050, lng: 74.2433 },
    'BEED': { lat: 18.9892, lng: 75.7601 },
    'NORTH DELHI': { lat: 28.6853, lng: 77.2155 },
    'SIKAR': { lat: 27.6018, lng: 75.1396 }
};
const DEFAULT_COORDS = { lat: 10.7867, lng: 76.6548 };
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
    catch (e) {
        console.error('Failed to read cache file, starting fresh', e);
    }
}
function saveCache() {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}
async function getRealCoordinates(address, name, district, state) {
    const pinMatch = address.match(/\b\d{6}\b/);
    const pincode = pinMatch ? pinMatch[0] : null;
    const queries = [];
    if (pincode) {
        queries.push(`${pincode}, India`);
    }
    queries.push(`${name}, ${district}, ${state}, India`);
    queries.push(`${district}, ${state}, India`);
    for (const q of queries) {
        const cleanQ = q.trim();
        if (cache[cleanQ]) {
            return cache[cleanQ];
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanQ)}&format=json&limit=1&countrycodes=in`;
            console.log(`Geocoding query: ${cleanQ}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'fapoms-production-geocoder/1.0 (info@fapoms.com)'
                }
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = await res.json();
                if (data && data[0]) {
                    const coords = {
                        lat: parseFloat(data[0].lat),
                        lng: parseFloat(data[0].lon)
                    };
                    cache[cleanQ] = coords;
                    saveCache();
                    return coords;
                }
            }
        }
        catch (err) {
            console.error(`Error geocoding: ${cleanQ}`, err);
        }
    }
    const districtKey = district.trim().toUpperCase();
    return DISTRICT_COORDS[districtKey] || DEFAULT_COORDS;
}
function getStateZone(stateName) {
    const s = stateName.toUpperCase();
    if (['KERALA', 'TAMIL NADU', 'KARNATAKA', 'ANDHRA PRADESH', 'TELANGANA', 'PUDUCHERRY', 'PONDICHERRY'].some(x => s.includes(x))) {
        return 'South Zone';
    }
    if (['MAHARASHTRA', 'GOA', 'GUJARAT'].some(x => s.includes(x))) {
        return 'West Zone';
    }
    if (['DELHI', 'NORTH DELHI', 'NOIDA', 'PUNJAB', 'HARYANA', 'RAJASTHAN', 'UTTAR PRADESH', 'JHUNJHUNU', 'SIKAR'].some(x => s.includes(x))) {
        return 'North Zone';
    }
    return 'East Zone';
}
const INDIAN_NAMES = ['Aravind Swamy', 'Karthik Raja', 'Siddharth Rao', 'Vijay Shankar', 'Rohan Mehta', 'Vikram Sen', 'Pranav Nair', 'Anand Krishnan', 'Rahul Sharma', 'Manish Patil'];
async function seed() {
    console.log('Connecting to database...');
    await data_source_1.AppDataSource.initialize();
    console.log('Database connected.');
    try {
        const orgRepo = data_source_1.AppDataSource.getRepository(organization_entity_1.OrganizationEntity);
        const clientRepo = data_source_1.AppDataSource.getRepository(client_entity_1.ClientEntity);
        const clientConfigRepo = data_source_1.AppDataSource.getRepository(client_configuration_entity_1.ClientConfigurationEntity);
        const zoneRepo = data_source_1.AppDataSource.getRepository(zone_entity_1.ZoneEntity);
        const branchRepo = data_source_1.AppDataSource.getRepository(branch_entity_1.BranchEntity);
        const assayerRepo = data_source_1.AppDataSource.getRepository(assayer_entity_1.AssayerEntity);
        let defaultOrg = await orgRepo.findOne({ where: { code: 'FAPOMS' } });
        if (!defaultOrg) {
            defaultOrg = orgRepo.create({
                name: 'FAPOMS Private Limited',
                code: 'FAPOMS',
                displayName: 'FAPOMS',
            });
            defaultOrg = await orgRepo.save(defaultOrg);
        }
        let rblClient = await clientRepo.findOne({ where: { clientCode: 'RBL' } });
        if (!rblClient) {
            const config = clientConfigRepo.create({
                workingDays: [1, 2, 3, 4, 5],
                defaultRadius: 50.0,
                serviceLevel: 'STANDARD',
                maxResponseTimeHours: 8,
                effectiveFrom: new Date(),
                createdBy: 'system',
                updatedBy: 'system',
            });
            rblClient = clientRepo.create({
                clientCode: 'RBL',
                name: 'RBL Bank (Indel)',
                displayName: 'RBL Bank',
                industry: 'Banking',
                clientType: 'BANK',
                lifecycleStatus: 'ACTIVE',
                priority: 'HIGH',
                configuration: config,
                organizationId: defaultOrg.id,
                createdBy: 'system',
                updatedBy: 'system',
            });
            rblClient = await clientRepo.save(rblClient);
            console.log('Created Client RBL Bank (Indel).');
        }
        console.log('Cleaning existing database branches & assayers details...');
        await data_source_1.AppDataSource.query('TRUNCATE TABLE assignments, project_branches, branches, assayers, zones CASCADE;');
        console.log('Seeding Zones for RBL Bank...');
        const zonesData = [
            { name: 'South Zone', states: ['KERALA', 'TAMIL NADU', 'KARNATAKA', 'ANDHRA PRADESH', 'TELANGANA', 'PUDUCHERRY', 'PONDICHERRY'] },
            { name: 'West Zone', states: ['MAHARASHTRA'] },
            { name: 'North Zone', states: ['DELHI', 'RAJASTHAN', 'UTTAR PRADESH'] },
            { name: 'East Zone', states: ['ODISHA', 'ORISSA'] }
        ];
        const zonesMap = new Map();
        for (const z of zonesData) {
            const zone = zoneRepo.create({
                name: z.name,
                description: `${z.name} operations management for RBL Bank`,
                clientId: rblClient.id,
                states: z.states,
                districts: []
            });
            const savedZone = await zoneRepo.save(zone);
            zonesMap.set(z.name, savedZone);
        }
        console.log(`Seeded ${zonesMap.size} Zones successfully.`);
        const excelPath = "/Users/deepstacker/WorkSpace/dupcq/gssAutomation/RBL(Indel) - Jun'26.xlsx";
        const workbook = xlsx.readFile(excelPath);
        console.log('Seeding branches from Excel...');
        const branchSheet = workbook.Sheets['Branch'];
        const branchesData = xlsx.utils.sheet_to_json(branchSheet);
        let branchCount = 0;
        for (const row of branchesData) {
            const branchName = (row.BRANCH_NAME || '').toString().trim();
            if (!branchName)
                continue;
            const district = (row.DISTRICT || '').toString().trim().toUpperCase();
            const state = (row.STATE || '').toString().trim();
            const address = (row['Branch Address'] || '').toString().trim();
            const branchCode = (row.BRANCH || `RBL-BR-${branchCount + 1}`).toString().trim();
            const coords = await getRealCoordinates(address, branchName, district, state);
            const zoneName = getStateZone(state);
            const zone = zonesMap.get(zoneName);
            const region = state;
            const territory = `${district} Area`;
            const managerName = INDIAN_NAMES[branchCount % INDIAN_NAMES.length];
            const phone = `+9144${Math.floor(10000000 + Math.random() * 90000000)}`;
            const pincode = address.match(/\b\d{6}\b/)?.[0] || null;
            const branchType = ['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA'].includes(district) ? 'METRO' : 'URBAN';
            const branch = branchRepo.create({
                branchCode,
                solId: branchCode,
                name: branchName,
                address,
                state,
                district,
                city: district,
                pincode,
                branchType,
                latitude: coords.lat,
                longitude: coords.lng,
                location: { type: 'Point', coordinates: [coords.lng, coords.lat] },
                organizationId: defaultOrg.id,
                clientId: rblClient.id,
                zoneId: zone ? zone.id : null,
                region,
                territory,
                managerName,
                phone,
                email: `${branchName.toLowerCase().replace(/\s+/g, '')}@rblbank.com`,
                riskScore: 2.0,
                riskCategory: 'LOW',
                complexity: 'STANDARD',
                estimatedDurationHours: 6.0,
                createdBy: 'system',
                updatedBy: 'system',
            });
            await branchRepo.save(branch);
            branchCount++;
            if (branchCount % 10 === 0) {
                console.log(`Processed ${branchCount} branches...`);
            }
        }
        console.log(`Seeded ${branchCount} branches successfully.`);
        console.log('Seeding assayers from Excel...');
        const assayerSheet = workbook.Sheets['Assayer '];
        const assayersData = xlsx.utils.sheet_to_json(assayerSheet);
        let assayerCount = 0;
        for (const row of assayersData) {
            const fullName = (row['Assayer Name'] || '').toString().trim();
            if (!fullName)
                continue;
            const assayerCode = (row['Assayer code'] || `AS-${assayerCount + 1}`).toString().trim();
            const address = (row['Residence Address'] || '').toString().trim();
            const locationName = (row['Location'] || '').toString().trim();
            const district = (row['District'] || '').toString().trim().toUpperCase();
            const state = (row['State'] || '').toString().trim();
            const names = fullName.split(/\s+/);
            const firstName = names[0] || 'Assayer';
            const lastName = names.slice(1).join(' ') || 'User';
            const coords = await getRealCoordinates(address, locationName || district, district, state);
            const phone = `+9199${Math.floor(10000000 + Math.random() * 90000000)}`;
            const pincode = address.match(/\b\d{6}\b/)?.[0] || null;
            const panNumber = `PANPL${Math.floor(1000 + Math.random() * 9000)}B`;
            const bankAccountNumber = `9200${Math.floor(10000000 + Math.random() * 90000000)}`;
            const ifscCode = `RBLB0000${Math.floor(100 + Math.random() * 900)}`;
            const assayer = assayerRepo.create({
                assayerCode,
                firstName,
                lastName,
                displayName: fullName,
                phone,
                email: `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/\s+/g, '')}@rbl-assayer.com`,
                address,
                state,
                district,
                city: locationName || district,
                pincode,
                panNumber,
                bankAccountNumber,
                ifscCode,
                latitude: coords.lat,
                longitude: coords.lng,
                location: { type: 'Point', coordinates: [coords.lng, coords.lat] },
                status: 'ACTIVE',
                lifecycleStatus: shared_1.AssayerLifecycleStatus.ACTIVE,
                eligibleClients: ['*'],
                organizationId: defaultOrg.id,
                createdBy: 'system',
                updatedBy: 'system',
            });
            await assayerRepo.save(assayer);
            assayerCount++;
        }
        console.log(`Seeded ${assayerCount} assayers successfully.`);
        console.log('Real RBL Bank (Indel) Client Seeding with real geocoded coordinates, zones, regions, and manager attributes completed successfully!');
    }
    catch (err) {
        console.error('Error during RBL Seeding:', err);
    }
    finally {
        await data_source_1.AppDataSource.destroy();
    }
}
seed();
//# sourceMappingURL=seed-rbl.js.map