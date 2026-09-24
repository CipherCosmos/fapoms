/**
 * What the iPhone build of the NEW app has been given, from environment values only.
 *
 * Shared by `app.config.js` (which config plugins to apply) and `react-native.config.js` (which
 * native modules to link), so the two can never disagree. Everything the owner supplies later is
 * optional: when a value is missing the matching feature is switched off and the build still works.
 * See IOS-SETUP.md.
 *
 *  - GOOGLE_SERVICE_INFO_PLIST: path to the Firebase iOS config for bundle `com.fapoms.assayer`
 *    (on EAS: a "file" environment variable). Without a valid one, iPhone push is off.
 *  - APPLE_TEAM_ID: the 10-character Apple Developer Team ID. Without it, invite links
 *    (Associated Domains) are off on iPhone.
 *
 * Nothing here prints or throws: the one notice is printed by `withIosSetupNotice`, which runs
 * only while an iOS native project is being generated — an Android build never sees it.
 */
const fs = require('fs');
const path = require('path');

const IOS_BUNDLE_ID = 'com.fapoms.assayer';

function plistString(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return m ? m[1].trim() : null;
}

/** { enabled, plistPath?, problem? } for iPhone push via Firebase. */
function iosFirebase(projectRoot = path.resolve(__dirname, '..')) {
  const raw = process.env.GOOGLE_SERVICE_INFO_PLIST;
  if (!raw) return { enabled: false, problem: 'GOOGLE_SERVICE_INFO_PLIST is not set' };
  const plistPath = path.resolve(projectRoot, raw);
  let xml;
  try {
    xml = fs.readFileSync(plistPath, 'utf8');
  } catch {
    return { enabled: false, problem: `GOOGLE_SERVICE_INFO_PLIST points to ${plistPath}, which cannot be read` };
  }
  const bundle = plistString(xml, 'BUNDLE_ID');
  if (bundle !== IOS_BUNDLE_ID) {
    return {
      enabled: false,
      problem: `GoogleService-Info.plist is for bundle "${bundle ?? '(none)'}", but the app is "${IOS_BUNDLE_ID}" — download the plist of the iOS app registered as ${IOS_BUNDLE_ID} in Firebase`,
    };
  }
  if (!plistString(xml, 'GOOGLE_APP_ID')) {
    return { enabled: false, problem: 'GoogleService-Info.plist has no GOOGLE_APP_ID — it is not a Firebase iOS config file' };
  }
  return { enabled: true, plistPath };
}

/** The Apple Team ID, or null when unset / not the 10-character form. */
function appleTeamId() {
  const id = (process.env.APPLE_TEAM_ID || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(id) ? id : null;
}

module.exports = { IOS_BUNDLE_ID, iosFirebase, appleTeamId };
