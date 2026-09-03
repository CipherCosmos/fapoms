/**
 * FAPOMS — Assayer self-service (the registration checklist a field worker can read)
 *
 * An assayer could already *write* their own paperwork — `PUT /assayers/:id/document/:requirement`
 * and `POST .../file` have carried `SystemRole.ASSAYER` and `assertSelfOrPrivileged` for some
 * time — but every route that reads those rows back (`:assayerId/dossier`,
 * `document/:id/file/:index`) is ADMIN/OPERATIONS only. So the phone could post a scan into a
 * void and had no way to ask what was still outstanding, or to see what it had just sent. That
 * asymmetry is the whole reason this controller exists; it adds no write path.
 *
 * A separate file rather than more routes on `AssayerController` because the audience is
 * different: everything here answers "what do *I* still owe HR", is safe for the person
 * themselves to see, and deliberately carries no other assayer's data and no PII beyond a yes/no.
 */

import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  Inject,
  UseGuards,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  SystemRole,
  OnboardingDocument,
  ONBOARDING_DOCUMENT_LABELS,
  isIdentityDocument,
} from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, OnboardingAllowed } from '../auth/guards';
import { assertSelfOrPrivileged } from './assayer-visibility';
import { RosterRecordsService } from './roster-records.service';
import { AssayerDocumentEntity } from './assayer-document.entity';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { ASSAYER_ERROR_CODES } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';

/**
 * The paperwork a person can actually produce from a phone.
 *
 * The full `OnboardingDocument` vocabulary has 21 entries, but roughly half are issued by the
 * company or performed by HR — an appointment letter, a company ID card, the company stamp, a
 * reference check, a governance audit. Listing those on a field worker's screen as things they
 * "still need" would be asking them for something only the office can produce; the predictable
 * result is a support call, not a scan. Only what the person themselves holds appears here.
 *
 * This list is a mobile-presentation policy, not a change to the vocabulary, which is why it
 * lives beside the route that serves it rather than in `@fapoms/shared`.
 *
 * Re-checked before leaving it here: the web registration wizard holds no list of its own — it
 * renders whatever the dossier returns — so there is no second copy of this split to drift from.
 * That is the condition to re-test if it moves. The day a screen needs to say "the office will
 * produce these, you bring those" without asking the server, the split becomes a domain fact
 * shared by two clients and belongs beside `OnboardingDocument` in the shared vocabulary.
 */
const SELF_SERVICE_REQUIRED: readonly OnboardingDocument[] = [
  OnboardingDocument.PHOTOGRAPH,
  OnboardingDocument.AADHAAR_FRONT,
  OnboardingDocument.AADHAAR_BACK,
  OnboardingDocument.PAN_CARD,
  OnboardingDocument.BANK_PASSBOOK,
  OnboardingDocument.JOINING_FORM,
  OnboardingDocument.NDA,
  OnboardingDocument.CODE_OF_CONDUCT,
  OnboardingDocument.ETHICAL_CONDUCT_LETTER,
];

/**
 * Accepted if offered, never chased.
 *
 * These are alternates — somebody with a passport does not also need a voter ID — so counting
 * them as outstanding would make a complete file look permanently incomplete. They are returned
 * so the app can offer "add another proof" without inventing its own list.
 */
const SELF_SERVICE_OPTIONAL: readonly OnboardingDocument[] = [
  OnboardingDocument.ADDRESS_PROOF,
  OnboardingDocument.DRIVING_LICENCE,
  OnboardingDocument.VOTER_ID,
  OnboardingDocument.PASSPORT,
];

@ApiTags('Assayers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayers')
export class AssayerSelfServiceController {
  constructor(
    private readonly rosterRecords: RosterRecordsService,
    @InjectRepository(AssayerDocumentEntity)
    private readonly documents: Repository<AssayerDocumentEntity>,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
  ) {}

  /**
   * What this person still owes HR, and what has already landed.
   *
   * **A requirement is satisfied only when a file is attached.** `soft_copy_received` is true on
   * 10,977 rows and not one of them has a file behind it — the flag records what the migrated
   * roster spreadsheet asserted in some past year, not that a scan exists in this system. Reading
   * it as evidence would tell nearly every field worker their paperwork was complete when nothing
   * has ever been uploaded. It is therefore not merely ignored here, it is not returned at all,
   * so no future client can rediscover it and draw the same wrong conclusion.
   *
   * Built on `RosterRecordsService.dossier` rather than a query of its own so the "a missing row
   * and an empty row mean the same thing" projection stays in one place — that rule is the reason
   * a person with no rows at all shows as fully outstanding instead of fully done. The cost is a
   * handful of extra indexed reads (references, empanelments, checks) that are discarded here;
   * that is cheaper than a second copy of the checklist rules drifting from the first.
   */
  @Get(':assayerId/registration-checklist')
  @OnboardingAllowed()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'What paperwork this person still needs to send' })
  async registrationChecklist(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Req() req: any,
  ) {
    assertSelfOrPrivileged(req.user, assayerId, 'view this checklist');

    const dossier = await this.rosterRecords.dossier(assayerId);
    const byRequirement = new Map(
      (dossier.onboarding as any[]).map((row) => [row.requirement as OnboardingDocument, row]),
    );

    const project = (requirement: OnboardingDocument, optional: boolean) => {
      const row = byRequirement.get(requirement);
      const filePaths: string[] = row?.filePaths ?? [];
      return {
        requirement,
        label: ONBOARDING_DOCUMENT_LABELS[requirement],
        optional,
        identity: isIdentityDocument(requirement),
        // The single source of truth for "have we got it". See the note above about
        // `soft_copy_received`, which is deliberately absent from this payload.
        hasScan: filePaths.length > 0,
        fileCount: filePaths.length,
        verificationStatus: row?.verificationStatus ?? null,
        expiryDate: row?.expiryDate ?? null,
        // Whether the number is on file, never the number itself. The person is entitled to see
        // their own PAN, but a checklist has no use for it, and a payload that never carries it
        // cannot leak it through a log, a crash report or a cached response on a shared handset.
        hasNumber: Boolean(row?.documentNumber),
      };
    };

    const required = SELF_SERVICE_REQUIRED.map((r) => project(r, false));
    const optional = SELF_SERVICE_OPTIONAL.map((r) => project(r, true));
    const outstanding = required.filter((item) => !item.hasScan);

    return {
      success: true,
      data: {
        items: [...required, ...optional],
        summary: {
          required: required.length,
          received: required.length - outstanding.length,
          outstanding: outstanding.length,
          // Named so a client cannot mistake it for a gate. Nothing in this system waits on it:
          // HR completes registrations from the desk with no phone involved, and that has to stay
          // true — this route describes progress, it does not confer or withhold anything.
          complete: outstanding.length === 0,
        },
      },
    };
  }

  /**
   * Read back a scan this person sent.
   *
   * Addressed by requirement rather than by document id because that is all the phone knows: it
   * uploaded to `POST :assayerId/document/:requirement/file` and never saw a row id. The staff
   * route (`document/:id/file/:index`) takes an id and is unusable from the app for that reason.
   *
   * Ownership is checked against the path, then the row is fetched *scoped to that same
   * assayer* — so a requirement string cannot be used to reach a row belonging to somebody else
   * even if the id check were ever loosened.
   */
  @Get(':assayerId/document/:requirement/file/:index')
  @OnboardingAllowed()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Fetch a scan attached to your own document' })
  async getOwnDocumentFile(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('requirement') requirement: string,
    @Param('index') index: string,
    @Req() req: any,
    @Res() res: any,
  ): Promise<void> {
    assertSelfOrPrivileged(req.user, assayerId, 'view these documents');

    if (!Object.values(OnboardingDocument).includes(requirement as OnboardingDocument)) {
      throw withCode(
        new BadRequestException('No such document type.'),
        ASSAYER_ERROR_CODES.DOCUMENT_REQUIREMENT_UNKNOWN,
      );
    }
    // A non-numeric or negative index would index the array with `undefined` or wrap round the
    // end; both would surface as a confusing 404 rather than a bad request.
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0) {
      throw new BadRequestException('That is not a file number.');
    }

    const row = await this.documents.findOne({
      where: { assayerId, requirement: requirement as OnboardingDocument },
    });
    const key = row?.filePaths?.[position];
    if (!key) throw new NotFoundException('No such file on this document.');

    const stream = await this.storage.getFileStream(key);
    // Same handling as the staff route: an identity scan is served as an opaque download with
    // nosniff, so nothing uploaded to a personnel file can execute in this application's origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${row!.requirement}"`);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
