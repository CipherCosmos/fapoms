/**
 * Keeps release APKs off the debug signing key.
 *
 * React Native generates `android/app/build.gradle` with the release buildType pointing at
 * `signingConfigs.debug` — its own comment warns not to ship that. The debug key ships in every
 * RN project with the password "android", so an APK signed with it can be replaced by an update
 * anyone is able to produce. Android also identifies an app by its signing key, which means a
 * debug-signed release can never be updated by a properly signed one: users would have to
 * uninstall and lose local data.
 *
 * This has to be a config plugin rather than an edit to `android/app/build.gradle`, because that
 * directory is gitignored — it is a `expo prebuild` artifact, regenerated from scratch, and a
 * hand-edit to it survives exactly until the next prebuild and then disappears silently. A
 * plugin is re-applied every time the native project is generated.
 *
 * Credentials are never in the repository. They arrive as Gradle properties at build time:
 *
 *   ./gradlew assembleRelease -PFAPOMS_KEYSTORE=… -PFAPOMS_KEYSTORE_PASSWORD=… \
 *                             -PFAPOMS_KEY_ALIAS=…  -PFAPOMS_KEY_PASSWORD=…
 *
 * When they are absent the build falls back to the debug key, so an ordinary developer running a
 * local release build is not blocked. Only builds meant for other people need the real key — and
 * `BUILD-APK.md` says how to check which one an APK actually carries before handing it out.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_SIGNING_CONFIG = `
        release {
            if (project.hasProperty('FAPOMS_KEYSTORE')) {
                storeFile file(project.property('FAPOMS_KEYSTORE'))
                storePassword project.property('FAPOMS_KEYSTORE_PASSWORD')
                keyAlias project.property('FAPOMS_KEY_ALIAS')
                keyPassword project.property('FAPOMS_KEY_PASSWORD')
            }
        }
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;

    // Idempotent: prebuild may run repeatedly, and applying this twice must not corrupt the file.
    if (!gradle.includes('FAPOMS_KEYSTORE')) {
      // Add a `release` signing config beside the generated `debug` one.
      gradle = gradle.replace(
        /(signingConfigs\s*\{[\s\S]*?\n {8}\}\n)/,
        `$1${RELEASE_SIGNING_CONFIG}`,
      );

      /**
       * Point the RELEASE buildType at it.
       *
       * Matched on the generated warning comment, which appears only in `buildTypes.release`.
       * An earlier version matched `/release\s*\{[\s\S]*?signingConfig signingConfigs\.debug/`
       * and quietly did the wrong thing: it matched the `release` block inside `signingConfigs`
       * that this plugin had just inserted, ran forward to the first
       * `signingConfig signingConfigs.debug` in the file — the one in `buildTypes.debug` — and
       * patched that instead, leaving release on the debug key. The result was a release APK
       * signed `CN=Android Debug` from a build that reported success.
       */
      gradle = gradle.replace(
        /\/\/ Caution! In production[^\n]*\n\s*\/\/ see https:\/\/reactnative\.dev[^\n]*\n(\s*)signingConfig signingConfigs\.debug/,
        `$1signingConfig project.hasProperty('FAPOMS_KEYSTORE') ? signingConfigs.release : signingConfigs.debug`,
      );

      /**
       * Verify the RELEASE buildType specifically — not merely that the name appears somewhere.
       *
       * The weaker check (`gradle.includes('FAPOMS_KEYSTORE')`) passed while the patch had landed
       * in the wrong block, which is how a debug-signed release got built and packaged. This
       * isolates `buildTypes { … release { … } }` and asserts the conditional is inside it.
       */
      const buildTypes = gradle.match(/buildTypes\s*\{([\s\S]*?)\n {4}\}/);
      const releaseBlock = buildTypes && buildTypes[1].match(/release\s*\{([\s\S]*?)\n {8}\}/);
      if (!releaseBlock || !releaseBlock[1].includes("hasProperty('FAPOMS_KEYSTORE')")) {
        throw new Error(
          'withReleaseSigning: buildTypes.release was not patched — release APKs would be signed ' +
            'with the DEBUG key. The generated build.gradle template has changed; update this ' +
            'plugin rather than shipping an unsigned-for-production build.',
        );
      }
    }

    cfg.modResults.contents = gradle;
    return cfg;
  });
};
