import { ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import type { Readable } from 'stream';
import { AssayerLifecycleStatus, EventCategory, scanMimeType } from '@fapoms/shared';
import { AssayerService } from './assayer.service';
import { RosterRecordsService } from './roster-records.service';
import { ComplianceStandingService } from './compliance-standing.service';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { runOutsideRequestContext } from '../../core/context/request-context';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { appPublicUrl } from '../../infrastructure/notifications/email-provider';
import { idCardFace, streamToBuffer, type IdCardFace } from './id-card';
import {
  LIVE_CODE_WINDOW_SECONDS, PHOTO_TOKEN_TTL_SECONDS, checkLiveCardCode, codeWindow, idCardKey, liveCardCode,
  signCardToken, verifyCardToken,
} from './id-card-verification';

/** The card as the app draws it: the face, and the person's own photograph. */
export interface MyIdCard extends IdCardFace {
  /** A data URL of their photograph, or null — only ever sent to the person themselves. */
  photo: string | null;
}

/** What the card shows for the next minute: the QR, the 6 digits, and when they change. */
export interface LiveIdCardCode {
  verifyUrl: string;
  qr: string;
  code: string;
  /** Epoch ms at which this code stops being the current one. */
  changesAt: number;
  /** The server's clock, so the app counts down against it rather than a phone's drifting one. */
  serverNow: number;
}

/** The public verification page's answer. Says as little about the person as a check needs. */
export interface IdCardVerification {
  result: 'VALID' | 'NOT_VALID' | 'CODE_EXPIRED' | 'NO_MATCH';
  /** Plain sentence for the person checking. */
  message: string;
  fullName?: string;
  assayerCode?: string;
  jobTitle?: string;
  organisation?: string | null;
  validTill?: string;
  /** Whether they may be given new audit work today — a hold on compliance grounds says no. */
  clearedForNewWork?: boolean;
  /** Short-lived link to their photograph, to match against the person in front of you. */
  photoUrl?: string | null;
  checkedAt: string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * How many wrong codes one ID number may take before the typed check is closed for it.
 *
 * The per-IP throttle alone (10 a minute) still lets a patient guesser, or several addresses, work
 * through the 6-digit space for one person; a live code is valid for about two minutes, so the
 * counter is kept per ID number, across every address. Five wrong in fifteen minutes is far past
 * any honest typo, and a lock only closes the TYPED route — scanning the QR still works, so the
 * person in front of the counter is never stranded by somebody else's guessing.
 */
export const ID_CARD_CODE_MAX_FAILURES = 5;
export const ID_CARD_CODE_FAIL_WINDOW_SECONDS = 15 * 60;
export const ID_CARD_CODE_LOCK_SECONDS = 15 * 60;
const failKey = (code: string) => `idcard:verify-fail:${code}`;
const lockKey = (code: string) => `idcard:verify-lock:${code}`;

/**
 * THE DIGITAL ID CARD — the app's card, its live code, and the public check of both
 * (owner, 2026-09-23). See `id-card.ts` for the card and `id-card-verification.ts` for the code.
 */
@Injectable()
export class IdCardService {
  private readonly key: Buffer;

  constructor(
    private readonly assayerService: AssayerService,
    private readonly rosterRecords: RosterRecordsService,
    private readonly auditService: AuditService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    config: ConfigService,
    @Optional() private readonly compliance?: ComplianceStandingService,
    /** Wrong-code counters. Absent (no Redis), the check falls back to the per-IP throttle alone. */
    @Optional() private readonly cache?: CacheService,
  ) {
    this.key = idCardKey(config.get<string>('JWT_SECRET', 'dev-secret'));
  }

  /** The card face for anybody, read-only — HR's preview, the live code, the verification page. */
  async face(assayerId: string): Promise<IdCardFace> {
    const person = await this.assayerService.findOneForReading(assayerId);
    if (!person) throw new NotFoundException('Assayer not found.');
    const [terms, printed] = await Promise.all([
      this.rosterRecords.idCardTerms(assayerId),
      this.rosterRecords.idCardPrintedText(),
    ]);
    return idCardFace(person, terms, printed);
  }

  /**
   * The person opening their own card. This is the issuance — the moment the card is handed over —
   * so it goes through `idCardIssuance`, which puts any vetting gap it was issued with on the trail.
   */
  async myCard(assayerId: string): Promise<MyIdCard> {
    const person = await this.assayerService.findOneForReading(assayerId);
    if (!person) throw new NotFoundException('Assayer not found.');
    const [terms, printed] = await Promise.all([
      this.rosterRecords.idCardIssuance(assayerId, assayerId),
      this.rosterRecords.idCardPrintedText(),
    ]);
    return { ...idCardFace(person, terms, printed), photo: await this.photoDataUrl(person.photograph) };
  }

  /** The next minute's QR and code — only for a card that is issued. */
  async liveCode(assayerId: string): Promise<LiveIdCardCode> {
    const face = await this.face(assayerId);
    if (!face.issued) {
      throw new ConflictException(`Your ID card is not issued yet: ${face.blockedBecause.join('; ')}.`);
    }
    const now = nowSeconds();
    const token = signCardToken(this.key, assayerId, now);
    const verifyUrl = `${appPublicUrl()}/verify/card/${token}`;
    const qr = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
    return {
      verifyUrl,
      qr,
      code: liveCardCode(this.key, assayerId, codeWindow(now)),
      changesAt: (codeWindow(now) + 1) * LIVE_CODE_WINDOW_SECONDS * 1000,
      serverNow: Date.now(),
    };
  }

  /** A scanned QR. */
  async verifyByToken(token: string): Promise<IdCardVerification> {
    const check = verifyCardToken(this.key, token, nowSeconds());
    if (!check.ok) {
      return this.answer(check.why === 'expired'
        ? { result: 'CODE_EXPIRED', message: 'This code has expired. Ask them to open their ID card in the app and show you the live code.' }
        : { result: 'NO_MATCH', message: 'This is not a code issued by us.' }, null, 'QR');
    }
    // Signed-out, but the token has named the one person it may read — see runOutsideRequestContext.
    return runOutsideRequestContext(() => this.verifyPerson(check.assayerId, 'QR'));
  }

  /** The ID number and the 6 digits, typed in. The same answer for "no such person" and "wrong code". */
  async verifyByCode(assayerCode: string, code: string): Promise<IdCardVerification> {
    const noMatch = { result: 'NO_MATCH' as const, message: 'No live ID card matches that ID number and code. Check both, or ask them to show the code again — it changes every minute.' };
    const idNumber = String(assayerCode ?? '').trim().toUpperCase();
    // Counted per ID number whether or not anybody holds it: a lock that only real numbers could
    // earn would itself say which numbers are real.
    if (this.cache && (await this.cache.getJson<number>(lockKey(idNumber)))) {
      throw new HttpException(
        'Too many wrong codes for this ID number. Scan the QR code on their card instead, or try again in 15 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // Signed-out: one record, found by the ID number, and read further only if its live code matches.
    return runOutsideRequestContext(async () => {
      const person = await this.assayerService.getProfile(idNumber).catch(() => null);
      if (!person || !checkLiveCardCode(this.key, person.id, code, nowSeconds())) {
        await this.recordCodeFailure(idNumber);
        return this.answer(noMatch, null, 'CODE');
      }
      await this.cache?.del(failKey(idNumber));
      return this.verifyPerson(person.id, 'CODE');
    });
  }

  /** The photograph a verification is allowed to show, for a few minutes after it. */
  async photo(photoToken: string): Promise<{ stream: Readable; mimeType: string }> {
    const check = verifyCardToken(this.key, photoToken, nowSeconds(), 'p');
    if (!check.ok) throw new NotFoundException('This photo link has expired.');
    const person = await runOutsideRequestContext(() => this.assayerService.findOneForReading(check.assayerId)).catch(() => null);
    if (!person?.photograph) throw new NotFoundException('No photograph on file.');
    return {
      stream: await this.storage.getFileStream(person.photograph),
      mimeType: scanMimeType(person.photograph) ?? 'image/jpeg',
    };
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** One more wrong code for this ID number; at the limit, close the typed check for a while. */
  private async recordCodeFailure(idNumber: string): Promise<void> {
    if (!this.cache) return;
    const count = await this.cache.incrWithTtl(failKey(idNumber), ID_CARD_CODE_FAIL_WINDOW_SECONDS);
    if (count >= ID_CARD_CODE_MAX_FAILURES) {
      await this.cache.setJson(lockKey(idNumber), Date.now() + ID_CARD_CODE_LOCK_SECONDS * 1000, ID_CARD_CODE_LOCK_SECONDS);
      await this.cache.del(failKey(idNumber));
    }
  }

  private async verifyPerson(assayerId: string, method: 'QR' | 'CODE'): Promise<IdCardVerification> {
    const person = await this.assayerService.findOneForReading(assayerId).catch(() => null);
    if (!person) return this.answer({ result: 'NO_MATCH', message: 'We have no appraiser on record for this card.' }, null, method);
    const face = await this.face(assayerId);
    const expired = new Date(face.validTill).getTime() < Date.now();
    const valid = face.issued && !expired;
    const blockers = valid ? ((await this.compliance?.workBlockers(assayerId)) ?? []) : [];
    const identity = {
      fullName: face.fullName,
      assayerCode: face.assayerCode,
      jobTitle: face.jobTitle,
      organisation: face.organisation,
      validTill: face.validTill,
      photoUrl: person.photograph
        ? `/api/v1/public/id-card/photo/${signCardToken(this.key, assayerId, nowSeconds(), 'p', PHOTO_TOKEN_TTL_SECONDS)}`
        : null,
    };
    if (!valid) {
      // Why, in words for a bank counter — not the HR-internal reason.
      const why = expired ? 'The card has expired.'
        : person.lifecycleStatus !== AssayerLifecycleStatus.ACTIVE ? 'They are not currently an active appraiser with us.'
          : 'Their card is not currently issued.';
      return this.answer({ result: 'NOT_VALID', message: `This ID card is NOT valid. ${why} Do not admit them on this card.`, ...identity }, assayerId, method);
    }
    return this.answer({
      result: 'VALID',
      message: blockers.length === 0
        ? 'This ID card is valid, and they are cleared for audit work.'
        : 'This ID card is valid, but they are NOT cleared for new audit work at the moment. Check with us before admitting them.',
      clearedForNewWork: blockers.length === 0,
      ...identity,
    }, assayerId, method);
  }

  /** Every check is on the trail — the person can be told who looked at their card, and when. */
  private async answer(
    body: Omit<IdCardVerification, 'checkedAt'>,
    assayerId: string | null,
    method: 'QR' | 'CODE',
  ): Promise<IdCardVerification> {
    if (assayerId) {
      await this.auditService.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'ASSAYER_ID_CARD_VERIFIED',
        entityType: 'ASSAYER',
        entityId: assayerId,
        remarks: `ID card checked by ${method === 'QR' ? 'QR scan' : 'ID number and code'}: ${body.result}.`,
        metadata: { method, result: body.result, clearedForNewWork: body.clearedForNewWork ?? null },
      });
    }
    return { ...body, checkedAt: new Date().toISOString() };
  }

  private async photoDataUrl(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    try {
      const bytes = await streamToBuffer(await this.storage.getFileStream(key));
      return `data:${scanMimeType(key) ?? 'image/jpeg'};base64,${bytes.toString('base64')}`;
    } catch {
      // An unreadable photo must not stop the card: it draws initials instead.
      return null;
    }
  }
}
