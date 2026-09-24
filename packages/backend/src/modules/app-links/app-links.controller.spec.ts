import { AppLinksController, appleAppSiteAssociationFor, assetLinksFor, normaliseCertFingerprint } from './app-links.controller';
import { NO_ENVELOPE_KEY } from '../../infrastructure/http/response.interceptor';
import { SETTING_BY_KEY } from '../../infrastructure/settings/settings.registry';

const RELEASE = '65:EC:61:13:9B:44:E5:07:96:8E:92:78:37:F4:05:F1:42:BA:8D:A3:A3:0B:AA:64:90:24:B9:07:BD:17:A6:23';

describe('app links', () => {
  it('ships the release certificate of the published APK as the default fingerprint', () => {
    expect(SETTING_BY_KEY['registration.androidAppCertSha256'].default).toBe(RELEASE);
    expect(SETTING_BY_KEY['registration.iosAppTeamId'].default).toBe('');
  });

  it('accepts apksigner\'s bare hex and normalises it', () => {
    expect(normaliseCertFingerprint('65ec61139b44e507968e927837f405f142ba8da3a30baa649024b907bd17a623')).toBe(RELEASE);
    expect(normaliseCertFingerprint('not a fingerprint')).toBeNull();
  });

  it('builds the Android statement for com.fapoms.assayer', () => {
    expect(assetLinksFor(`${RELEASE}, junk`)).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.fapoms.assayer', sha256_cert_fingerprints: [RELEASE] },
    }]);
    expect(assetLinksFor('')).toEqual([]);
  });

  it('builds the iOS file only with a real Team ID', () => {
    expect(appleAppSiteAssociationFor('')).toBeNull();
    expect(appleAppSiteAssociationFor('ABCDE12345')).toEqual({
      applinks: { details: [{ appIDs: ['ABCDE12345.com.fapoms.assayer'], components: [{ '/': '/register/*' }] }] },
    });
  });

  it('serves raw JSON (no envelope) from settings, and 404s the iOS file until the Team ID is set', async () => {
    const settings: any = { get: jest.fn(async (k: string) => (k === 'registration.androidAppCertSha256' ? RELEASE : '')) };
    const c = new AppLinksController(settings);
    expect(await c.assetLinks()).toHaveLength(1);
    await expect(c.appleAppSiteAssociation()).rejects.toThrow(/Apple Team ID/);
    expect(Reflect.getMetadata(NO_ENVELOPE_KEY, AppLinksController.prototype.assetLinks)).toBe(true);
  });
});
