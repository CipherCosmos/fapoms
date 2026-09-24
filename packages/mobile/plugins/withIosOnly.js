/**
 * Apply a config plugin's iOS changes only.
 *
 * React Native Firebase's config plugins also edit the Android project (Gradle, manifest), but the
 * new app uses Firebase messaging on iPhone only — Android keeps its existing push path and does not
 * even link the module (react-native.config.js). Any Android mods the wrapped plugin registers are
 * discarded, so the Android build is exactly what it would be without it.
 */
module.exports = function withIosOnly(config, [plugin, props]) {
  // A package name means its config plugin (`<package>/app.plugin.js`), as Expo resolves it — not
  // the package's runtime entry.
  const resolved = typeof plugin === 'string' ? require(require.resolve(`${plugin}/app.plugin.js`, { paths: [__dirname] })) : plugin;
  const fn = resolved && resolved.default ? resolved.default : resolved;
  const androidBefore = config.mods && config.mods.android ? { ...config.mods.android } : undefined;
  const next = fn(config, props);
  next.mods = next.mods || {};
  if (androidBefore) next.mods.android = androidBefore;
  else delete next.mods.android;
  return next;
};
