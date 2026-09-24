# iPhone setup for the new Orbit app — what to supply

The new app (built with `EXPO_PUBLIC_APP_V2=1`) is fully wired for iPhone. Two things only you can
provide are still missing. **Until you add them, the iPhone build still builds and runs** — the
features that need them are simply off, and the build log prints which ones:

```
⚠️  Orbit (new app) iPhone build — switched off until supplied (see packages/mobile/IOS-SETUP.md):
   • iPhone push — GOOGLE_SERVICE_INFO_PLIST is not set
   • invite links on iPhone (Associated Domains) — APPLE_TEAM_ID is not set
```

When that list is empty, everything is on. Android builds never read or check any of this.

| You supply | Environment variable | Turns on |
|---|---|---|
| Firebase iOS config file | `GOOGLE_SERVICE_INFO_PLIST` (a file) | iPhone push notifications |
| Apple Developer Team ID | `APPLE_TEAM_ID` (text, 10 characters) | Invite links opening the app on iPhone |
| APNs key, uploaded to Firebase | — (Firebase console) | Delivery of those pushes to iPhones |

Already done in the app, nothing to supply: automatic check-in in the background, background sync,
silent refresh pushes, the login staying readable while the phone is locked (so arrival check-in
works in a pocket), and the `com.fapoms.assayer://` link scheme.

---

## 1. Apple Team ID → `APPLE_TEAM_ID`

1. Sign in at <https://developer.apple.com/account> → **Membership details**.
2. Copy **Team ID** (10 letters/digits, e.g. `AB12CD34EF`).
3. Set it for the build:
   - EAS: Expo dashboard → the project → **Environment variables** → add `APPLE_TEAM_ID`, plain
     text, for the environment you build the new app with.
   - Local build: `export APPLE_TEAM_ID=AB12CD34EF`.

Where it is used: the app's `appleTeamId` and its **Associated Domains** entitlement
(`applinks:<your server host>`). The server must publish the matching file (step 4).

## 2. Firebase iOS config → `GOOGLE_SERVICE_INFO_PLIST`

1. <https://console.firebase.google.com> → project **fapoms-gss** → ⚙ **Project settings** →
   **Your apps** → **Add app** → **iOS**.
2. **Apple bundle ID: `com.fapoms.assayer`** (exactly — it is the app's iOS bundle id).
   The `GoogleService-Info.plist` currently in this folder is for `com.fapoms.mobile`; the build
   refuses it for push and says so.
3. Download the new **GoogleService-Info.plist**. Keep it out of git.
4. Set it for the build:
   - EAS: **Environment variables** → add `GOOGLE_SERVICE_INFO_PLIST`, type **File**, upload the
     plist, visibility **Secret**.
   - Local build: `export GOOGLE_SERVICE_INFO_PLIST=/full/path/to/GoogleService-Info.plist`.

The build checks the file is readable, is for `com.fapoms.assayer`, and has a `GOOGLE_APP_ID`.
Anything else → push stays off, with the reason in the build log.

## 3. APNs key → Firebase (so pushes reach iPhones)

1. <https://developer.apple.com/account> → **Certificates, Identifiers & Profiles** → **Keys** → **+**.
2. Name it (e.g. "Orbit push"), tick **Apple Push Notifications service (APNs)** → **Continue** →
   **Register** → **Download** the `.p8` file (Apple lets you download it **once**). Note the **Key ID**.
3. Firebase console → ⚙ **Project settings** → **Cloud Messaging** → **Apple app configuration** →
   the `com.fapoms.assayer` app → **APNs Authentication Key** → **Upload**: the `.p8`, the Key ID,
   and your Team ID (step 1).

## 4. Server files for invite links (whoever runs the server)

Invite links are `https://<server>/register/<token>`. For them to open the app instead of the browser:

- **iPhone** — serve `https://<server>/.well-known/apple-app-site-association` (no file extension,
  `Content-Type: application/json`):

  ```json
  { "applinks": { "details": [ { "appIDs": ["<TEAM_ID>.com.fapoms.assayer"], "components": [ { "/": "/register/*" } ] } ] } }
  ```

- **Android** (for completeness; already wired in the app) — serve
  `https://<server>/.well-known/assetlinks.json` naming package `com.fapoms.assayer` and the
  SHA-256 fingerprint of the key the APK is signed with.

## 5. Building the new app for iPhone

```
EXPO_PUBLIC_APP_V2=1
EXPO_PUBLIC_API_URL=https://<server host>     # https, or invite links stay off
APPLE_TEAM_ID=…                               # optional until supplied
GOOGLE_SERVICE_INFO_PLIST=…                   # optional until supplied
```

App ID capabilities (**Push Notifications**, **Associated Domains**) are switched on for
`com.fapoms.assayer` automatically by EAS when it manages the signing credentials; on a manually
managed App ID, tick them under **Identifiers** first.

## What is still off, and why, until these are supplied

| Missing | Effect | Everything else |
|---|---|---|
| `GOOGLE_SERVICE_INFO_PLIST` | No push notifications on iPhone (Firebase is not even linked into the build) | Works: arrival check-in, local "You have reached…" notices, background sync |
| APNs key in Firebase | Push registration works but nothing is delivered to iPhones | Works |
| `APPLE_TEAM_ID` | Invite links open in Safari, not the app (the invite still works on the web) | Works |
