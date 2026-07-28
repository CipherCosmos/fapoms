"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
describe('Planning Architecture Fitness Test', () => {
    const planningDir = path.join(__dirname, '.');
    const getSourceFiles = (dir) => {
        let results = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat && stat.isDirectory()) {
                results = results.concat(getSourceFiles(fullPath));
            }
            else if (file.endsWith('.ts') && !file.endsWith('.spec.ts')) {
                results.push(fullPath);
            }
        });
        return results;
    };
    it('should ensure Planning engine files do not contain forbidden imports', () => {
        const files = getSourceFiles(planningDir);
        const forbiddenImports = [
            '../branch/branch.entity',
            '../assayer/assayer.entity',
            '../assignment/assignment.entity',
            '../project/project.entity',
            'typeorm',
        ];
        const domainFiles = files.filter((f) => f.includes('coverage-planning.engine.ts'));
        domainFiles.forEach((file) => {
            const content = fs.readFileSync(file, 'utf8');
            forbiddenImports.forEach((forbidden) => {
                const containsForbidden = content.includes(forbidden);
                if (containsForbidden) {
                    throw new Error(`Architecture Violation: File ${file} contains forbidden import "${forbidden}"`);
                }
            });
        });
    });
});
//# sourceMappingURL=planning-architecture.spec.js.map