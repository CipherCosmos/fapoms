# Building a distributable APK

## One-off setup — the signing key

Android identifies an app by its signing key. **Back up `~/.fapoms-signing/` before you ship
anything.** Lose it and you can never update an installed APK — only publish a differently-named
app that users must uninstall and reinstall, losing local data.

The key already exists on the build machine. To recreate on another:

```bash
mkdir -p ~/.fapoms-signing && chmod 700 ~/.fapoms-signing
keytool -genkeypair -v -storetype PKCS12 \
  -keystore ~/.fapoms-signing/fapoms-release.keystore -alias fapoms \
  -keyalg RSA -keysize 4096 -validity 10950
```

Then write `~/.fapoms-signing/keystore.properties` with `FAPOMS_KEYSTORE`,
`FAPOMS_KEYSTORE_PASSWORD`, `FAPOMS_KEY_ALIAS`, `FAPOMS_KEY_PASSWORD`. It is outside the repo on
purpose and must stay that way.

Release builds fall back to the **debug** key when those properties are absent, so a local
release build still works for anyone — but never hand out an APK built that way. The debug key
ships in every React Native project with the password `android`, which means anyone can sign an
update that replaces your app.

## Build

```bash
cd packages/mobile
set -a; . ~/.fapoms-signing/keystore.properties; set +a
export ANDROID_HOME=$HOME/Library/Android/sdk
export EXPO_PUBLIC_API_URL="https://homeserver.tailc73ec8.ts.net"

cd android && ./gradlew assembleRelease --no-daemon \
  -PFAPOMS_KEYSTORE="$FAPOMS_KEYSTORE" \
  -PFAPOMS_KEYSTORE_PASSWORD="$FAPOMS_KEYSTORE_PASSWORD" \
  -PFAPOMS_KEY_ALIAS="$FAPOMS_KEY_ALIAS" \
  -PFAPOMS_KEY_PASSWORD="$FAPOMS_KEY_PASSWORD"
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

`EXPO_PUBLIC_API_URL` is inlined into the JS bundle at build time — Babel replaces the read with
the literal and drops the variable name, so grepping the bundle for `EXPO_PUBLIC_API_URL` finds
nothing while the URL itself is there. That is expected.

It is only the *default*: `server-config.ts` resolves **stored-on-device → build-time env →
development guess**, and the login screen has a server-URL field. A tester can point a build at a
different backend without a rebuild.

## Verify before distributing

```bash
BT=$ANDROID_HOME/build-tools/35.0.0
$BT/apksigner verify --print-certs app-release.apk | grep "certificate DN"   # must be CN=FAPOMS…
unzip -p app-release.apk assets/index.android.bundle | grep -ac "your.backend.host"
```

If the DN says `CN=Android Debug`, it was built without the keystore properties — do not ship it.

## Bumping the version

`versionCode` in `android/app/build.gradle` must increase for every build users upgrade onto;
Android refuses an install whose code is not higher than the installed one.
