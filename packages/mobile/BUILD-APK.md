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

---

# Distributing, and shipping updates

## The link to hand out

```
https://homeserver.tailc73ec8.ts.net/download/app.apk
```

Served straight from the deployment. Publishing a new build is a copy, not a redeploy:

```bash
scp app-release.apk shivam@100.67.63.97:~/fapoms-downloads/app.apk
```

Testers must allow "install unknown apps" for their browser once — unavoidable outside Play.

## Two kinds of update

|  | Reaches users by | Needs a reinstall? |
|---|---|---|
| Screens, logic, styling, images, default backend URL | **over the air** | no |
| New native module, permission, Expo SDK upgrade, `version` bump | new APK | yes |

Almost everything is the first row. The split is not a preference — an OTA payload is JavaScript,
and JS that calls a native module the installed binary does not contain crashes on launch with no
way back. `runtimeVersion: appVersion` enforces the boundary: bump `version` and older installs
stop being offered updates rather than being broken by one.

## One-time setup (needs your Expo account — free)

```bash
cd packages/mobile
npx eas login                 # free account
npx eas init                  # creates the project, prints a project ID
```

`eas-cli` is a devDependency of this package, so `npx eas` inside `packages/mobile` runs the
pinned local binary. Run it from anywhere else and npm will fetch a **different** package from
the registry that happens to be called `eas` — an unrelated project at version 0.1.0 — and
execute it. Stay in this directory, or use `npx eas-cli` by its full name.

Put the id in the build environment, then rebuild the APK **once** so it ships with the update
URL baked in:

```bash
export EAS_PROJECT_ID=<the id from eas init>
export EXPO_UPDATE_CHANNEL=production
# …then the normal build above
```

A build made before this has no update URL and can never receive OTA updates — it must be
replaced once.

## Channels must exist, or updates go nowhere

A build follows a **channel**; `eas update` publishes to a **branch**. They are different things
and must be linked, once:

```bash
npx eas channel:create production
```

Skip it and the failure is silent in the worst way: the update publishes successfully, the
dashboard shows it, and every handset asking for that channel gets a plain `404` forever. Nothing
errors, nobody is told, and the app simply never updates.

Verify what a device actually sees rather than trusting the dashboard:

```bash
curl -s -D- -o /dev/null "https://u.expo.dev/<projectId>" \
  -H "expo-platform: android" -H "expo-runtime-version: 1.0.0" \
  -H "expo-channel-name: production" -H "expo-protocol-version: 1" \
  -H "expo-api-version: 1" -H "Accept: multipart/mixed"
```

`200` with `content-type: multipart/mixed` means an update is being served. `404` means the
channel is missing or nothing is published for that runtime version.

## Shipping an update after that

```bash
cd packages/mobile
EXPO_PUBLIC_API_URL="https://homeserver.tailc73ec8.ts.net"   npx eas update --branch production --message "what changed"
```

Handsets fetch it in the background on next launch and apply it on the one after. No reinstall,
no prompt.

`fallbackToCacheTimeout: 0` means launch never blocks on the network — the app starts on the
bundle it already has, which is what you want on a handset with poor signal.

## Rolling back

```bash
npx eas update:rollback --branch production
```

Faster than a fix-forward, and the reason to prefer OTA for anything that can be JS.

## Cost

EAS Update's free tier covers 1,000 monthly active users. An internal assayer team is far inside
it. If that ever changes, `expo-updates` supports a self-hosted update server — the same app
builds work against it, only `updates.url` changes.
