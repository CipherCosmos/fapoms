import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AssayerController } from './assayer.controller';
import { AssayerService } from './assayer.service';
import { RosterImportService } from './roster-import.service';
import { ImportJobService } from '../import/import-job.service';
import { RosterRecordsService } from './roster-records.service';
import { DataIntegrityService } from './data-integrity.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { LocationTrailService } from './location-trail.service';
import { QualificationScoreService } from './qualification-score.service';
import { RosterQueryService } from './roster-query.service';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';

/**
 * `GET /assayers/identifier-check` — the registration wizard's duplicate lookup, asked as fields
 * are filled in rather than after a live probe found `POST /assayers` accepted a duplicate phone
 * with no complaint.
 *
 * Two things this pins:
 *
 *   1. Declaration order. Nest matches routes in the order they are declared, and a literal
 *      segment ("identifier-check") declared BELOW `@Get(':id')` would be captured by it instead
 *      and 400 on `ParseUUIDPipe` — exactly the failure mode `roster/import-issues` already
 *      documents for itself a little further up the same file. Static text analysis, not a
 *      NestJS test module — same technique as `assayer-controller-region-scope.spec.ts` — because
 *      what is being asserted is a property of the SOURCE, not of runtime behaviour a request
 *      would have to be constructed to observe.
 *   2. Match/exclude/empty behaviour, against a mocked `DataIntegrityService` — the route's only
 *      real collaborator, so nothing here touches a database.
 */
describe('GET /assayers/identifier-check', () => {
  describe('declaration order', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'assayer.controller.ts'), 'utf8');
    /**
     * Comments blanked, not removed, so character offsets stay usable. Several comments in this
     * file name `@Get(':id')` verbatim in prose — including the one directly above THIS route —
     * documenting the very rule being tested here for OTHER routes; left in, they would register
     * as an earlier "occurrence" of the real decorator and defeat the ordering check entirely.
     */
    const content = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

    it('is declared as a real route (canary: the pattern below is not silently matching nothing)', () => {
      expect(content).toMatch(/@Get\(\s*['"`]identifier-check['"`]\s*\)/);
    });

    it("is declared BEFORE @Get(':id') — the literal segment would otherwise be captured by it", () => {
      const identifierCheckAt = content.search(/@Get\(\s*['"`]identifier-check['"`]\s*\)/);
      const idRouteAt = content.search(/@Get\(\s*['"`]:id['"`]\s*\)/);

      expect(identifierCheckAt).toBeGreaterThan(-1);
      expect(idRouteAt).toBeGreaterThan(-1);
      expect(identifierCheckAt).toBeLessThan(idRouteAt);
    });

    it('carries the same view permission as the roster list it helps, not a wider one', () => {
      const start = content.search(/@Get\(\s*['"`]identifier-check['"`]\s*\)/);
      // The decorators for one route sit on the lines immediately above its @Get(...) — look
      // behind, not ahead, the same direction every other route in this file is decorated in.
      const before = content.slice(Math.max(0, start - 400), start);
      expect(before).toMatch(/@RequirePermissions\(\s*['"`]assayer:view:organization['"`]\s*\)/);
    });
  });

  describe('checkIdentifiers — match/exclude/empty, against a mocked source', () => {
    let controller: AssayerController;
    let dataIntegrity: { findIdentifierMatches: jest.Mock; findPhoneMatches: jest.Mock };

    beforeEach(async () => {
      dataIntegrity = {
        findIdentifierMatches: jest.fn().mockResolvedValue([]),
        findPhoneMatches: jest.fn().mockResolvedValue([]),
      };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AssayerController],
        providers: [
          { provide: AssayerService, useValue: {} },
          { provide: RosterImportService, useValue: {} },
          { provide: ImportJobService, useValue: {} },
          { provide: RosterRecordsService, useValue: {} },
          { provide: 'StorageEngine', useValue: {} },
          { provide: RegionGuardService, useValue: {} },
          { provide: LocationTrailService, useValue: {} },
          { provide: QualificationScoreService, useValue: {} },
          { provide: RosterQueryService, useValue: {} },
          { provide: DataIntegrityService, useValue: dataIntegrity },
          // The document-upload routes carry @UseInterceptors(FileScanInterceptor) at the class
          // level; Nest resolves it through DI when the module compiles even though this suite
          // never exercises those routes — same reason assayer.controller.spec.ts carries it.
          { provide: FileScanService, useValue: {} },
          FileScanInterceptor,
        ],
      }).compile();

      controller = module.get<AssayerController>(AssayerController);
    });

    it('empty when nothing is asked — no phone, PAN or Aadhaar supplied', async () => {
      const result: any = await controller.checkIdentifiers();

      expect(result).toEqual({ success: true, data: { matches: [] } });
      expect(dataIntegrity.findIdentifierMatches).toHaveBeenCalledWith({
        phone: undefined,
        panNumber: undefined,
        aadhaarNumber: undefined,
        excludeId: undefined,
      });
    });

    it('empty when the phone is clean', async () => {
      dataIntegrity.findIdentifierMatches.mockResolvedValue([]);

      const result: any = await controller.checkIdentifiers('9876500011');

      expect(result.data.matches).toEqual([]);
      expect(dataIntegrity.findIdentifierMatches).toHaveBeenCalledWith({
        phone: '9876500011',
        panNumber: undefined,
        aadhaarNumber: undefined,
        excludeId: undefined,
      });
    });

    it('reports a phone match, tagged matchedOn: "phone", with only the non-sensitive fields', async () => {
      dataIntegrity.findIdentifierMatches.mockResolvedValue([
        { id: 'asr-1', assayerCode: 'AS0001', displayName: 'Rajesh Gupta', lifecycleStatus: 'ACTIVE', matchedOn: 'phone' },
      ]);

      const result: any = await controller.checkIdentifiers('9876500011');

      expect(result).toEqual({
        success: true,
        data: {
          matches: [
            { id: 'asr-1', assayerCode: 'AS0001', displayName: 'Rajesh Gupta', lifecycleStatus: 'ACTIVE', matchedOn: 'phone' },
          ],
        },
      });
    });

    it('reports more than one match when the lookup finds more than one', async () => {
      dataIntegrity.findIdentifierMatches.mockResolvedValue([
        { id: 'asr-1', assayerCode: 'AS0001', displayName: 'Rajesh Gupta', lifecycleStatus: 'ACTIVE', matchedOn: 'phone' },
        { id: 'asr-2', assayerCode: 'AS0002', displayName: 'Rajesh Gupta II', lifecycleStatus: 'RESIGNED', matchedOn: 'phone' },
      ]);

      const result: any = await controller.checkIdentifiers('9876500011');

      expect(result.data.matches).toHaveLength(2);
      expect(result.data.matches.every((m: any) => m.matchedOn === 'phone')).toBe(true);
    });

    it('passes excludeId through, so the record being edited or resumed cannot match itself', async () => {
      await controller.checkIdentifiers('9876500011', undefined, undefined, 'asr-self');

      expect(dataIntegrity.findIdentifierMatches).toHaveBeenCalledWith({
        phone: '9876500011',
        panNumber: undefined,
        aadhaarNumber: undefined,
        excludeId: 'asr-self',
      });
    });

    it('evaluates panNumber and aadhaarNumber securely without exposing cleartext PII', async () => {
      dataIntegrity.findIdentifierMatches.mockResolvedValue([
        { id: 'asr-3', assayerCode: 'AS0003', displayName: 'Anil Kumar', lifecycleStatus: 'ACTIVE', matchedOn: 'panNumber' },
      ]);

      const result: any = await controller.checkIdentifiers(undefined, 'ABCDE1234F', '999941057058');

      expect(result).toEqual({
        success: true,
        data: {
          matches: [
            { id: 'asr-3', assayerCode: 'AS0003', displayName: 'Anil Kumar', lifecycleStatus: 'ACTIVE', matchedOn: 'panNumber' },
          ],
        },
      });
      expect(dataIntegrity.findIdentifierMatches).toHaveBeenCalledWith({
        phone: undefined,
        panNumber: 'ABCDE1234F',
        aadhaarNumber: '999941057058',
        excludeId: undefined,
      });
    });
  });
});
