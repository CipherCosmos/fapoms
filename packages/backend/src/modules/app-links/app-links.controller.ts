/**
 * INVITE LINKS THAT OPEN THE FIELD APP.
 *
 * A registration invite is `https://<host>/register/<token>`. The field app declares it handles
 * that path (Android intent filter with `autoVerify`, iOS associated domains), but each platform
 * opens the app only once the SITE confirms the app is really its own, by publishing:
 *
 *  - Android: `/.well-known/assetlinks.json` — the app's package and the SHA-256 fingerprint of the
 *    certificate it is signed with.
 *  - iOS: `/.well-known/apple-app-site-association` — `<TeamID>.<bundle id>` and the paths.
 *
 * Both must sit at the site ROOT over HTTPS with `Content-Type: application/json`. The API lives
 * under `/api/v1`, so the edge (deploy/Caddyfile) rewrites the two root paths to the routes below;
 * the values come from platform settings so a key rotation or the Apple Team ID needs no deploy.
 *
 * Public, no envelope (the files have a fixed format the operating system parses), cacheable for an
 * hour. Nothing here is secret: a signing fingerprint and a Team ID are public by design.
 */
import { Controller, Get, Header, NotFoundException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NoEnvelope } from '../../infrastructure/http/response.interceptor';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

/** The field app's identity on both stores (packages/mobile/app.config.js). */
export const FIELD_APP_ID = 'com.fapoms.assayer';
/** The invite path the app claims. Mirrors the Android intent filter's `pathPrefix`. */
export const INVITE_PATH_PREFIX = '/register/';

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Normalise one configured fingerprint to Android's colon-separated upper-case form, or null. */
export function normaliseCertFingerprint(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 64) return null;
  const pretty = hex.match(/../g)!.join(':');
  return FINGERPRINT.test(pretty) ? pretty : null;
}

export function assetLinksFor(fingerprintsSetting: string | null | undefined) {
  const fingerprints = String(fingerprintsSetting ?? '')
    .split(',')
    .map((f) => normaliseCertFingerprint(f.trim()))
    .filter((f): f is string => !!f);
  return fingerprints.length === 0
    ? []
    : [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: FIELD_APP_ID, sha256_cert_fingerprints: fingerprints },
    }];
}

/** Apple's format; null when no (valid) Team ID is configured. */
export function appleAppSiteAssociationFor(teamIdSetting: string | null | undefined) {
  const teamId = String(teamIdSetting ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(teamId)) return null;
  return {
    applinks: {
      details: [{ appIDs: [`${teamId}.${FIELD_APP_ID}`], components: [{ '/': `${INVITE_PATH_PREFIX}*` }] }],
    },
  };
}

@ApiTags('Public app links')
@Controller('public/app-links')
export class AppLinksController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get('assetlinks.json')
  @NoEnvelope()
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'Android App Links statement (served at /.well-known/assetlinks.json)' })
  async assetLinks() {
    const configured = await this.settings.get<string>('registration.androidAppCertSha256').catch(() => '');
    return assetLinksFor(configured);
  }

  /**
   * 404 until the Apple Team ID is set: an association file naming no app is worse than none, and
   * iOS falls back to opening the link in Safari either way.
   */
  @Get('apple-app-site-association')
  @NoEnvelope()
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'iOS universal links file (served at /.well-known/apple-app-site-association)' })
  async appleAppSiteAssociation() {
    const teamId = await this.settings.get<string>('registration.iosAppTeamId').catch(() => '');
    const body = appleAppSiteAssociationFor(teamId);
    if (!body) throw new NotFoundException('The Apple Team ID has not been set, so no iOS app is associated with this site yet.');
    return body;
  }
}
