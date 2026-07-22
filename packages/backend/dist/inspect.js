"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const xlsx = require("xlsx");
const filePath = "/Users/deepstacker/WorkSpace/dupcq/gssAutomation/RBL(Indel) - Jun'26.xlsx";
console.log('Reading file:', filePath);
try {
    const workbook = xlsx.readFile(filePath);
    const branchSheet = workbook.Sheets['Branch'];
    const branchData = xlsx.utils.sheet_to_json(branchSheet);
    const branchDistricts = new Set();
    branchData.forEach(row => {
        if (row.DISTRICT)
            branchDistricts.add(row.DISTRICT.trim().toUpperCase());
    });
    console.log('Unique Branch Districts:', Array.from(branchDistricts));
    const assayerSheet = workbook.Sheets['Assayer '];
    const assayerData = xlsx.utils.sheet_to_json(assayerSheet);
    const assayerDistricts = new Set();
    assayerData.forEach(row => {
        if (row.District)
            assayerDistricts.add(row.District.trim().toUpperCase());
    });
    console.log('Unique Assayer Districts:', Array.from(assayerDistricts));
}
catch (err) {
    console.error('Error reading excel file:', err);
}
//# sourceMappingURL=inspect.js.map