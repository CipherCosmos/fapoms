/**
 * Prints, once, which iPhone-only features this build of the new app has switched off because a
 * value is not supplied yet — so a build made before the owner provides them works, and says why
 * iPhone push or invite links are missing. It is an iOS mod, so it runs only when an iOS native
 * project is generated: Android builds never see it. See IOS-SETUP.md.
 */
const { withInfoPlist } = require('expo/config-plugins');

let printed = false;

module.exports = function withIosSetupNotice(config, { missing = [] } = {}) {
  return withInfoPlist(config, (cfg) => {
    if (!printed && missing.length > 0) {
      printed = true;
      console.warn(
        [
          '',
          '⚠️  Orbit (new app) iPhone build — switched off until supplied (see packages/mobile/IOS-SETUP.md):',
          ...missing.map((m) => `   • ${m}`),
          '',
        ].join('\n'),
      );
    }
    return cfg;
  });
};
