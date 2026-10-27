# Android app

The Android build of Orchestra. It is a native WebView wrapper around the web client that already lives in
`packages/app`: the production bundle is embedded in the APK and shown under an https origin, and the phone is a
client for an `orchestra` server the user connects to by hand.

Nothing about the UI is written here. With `VITE_ORCHESTRA_SERVER_MODE=none` the bundle opens on its own full-screen
connection form, where the user enters an address and password, pastes a pair link, or scans the QR code.

## How it works

| Concern | Where |
| --- | --- |
| Page origin | `https://appassets.androidplatform.net/`, answered from `assets/app` by `AssetHost` |
| Bundle | `packages/app` production build, copied into the APK as `assets/app` at build time |
| Version | `versionName` from the root `package.json`, `versionCode` derived from it (`2.0.24` -> `20024`) |
| Icons | copied from `packages/desktop/icons/beta/android` (beta channel) |
| Permissions | `INTERNET`, `CAMERA`, `RECORD_AUDIO`, requested at the moment the page asks for them |
| Language | Java, one Activity, no AndroidX and no third-party dependencies |

The origin is the reason the bundle is served through `shouldInterceptRequest` instead of `file:///android_asset`: a
file document is not a secure context, so `window.isSecureContext` is false and the QR scanner stays disabled. The same
interceptor is installed for the service worker (`ServiceWorkerClient`), because the production bundle registers
`/sw.js` and the worker fetches its precache itself.

`usesCleartextTraffic` and `MIXED_CONTENT_ALWAYS_ALLOW` are deliberate: a user connects to their own
`orchestra serve --hostname 0.0.0.0` over plain http on the LAN, while the page itself is an https document.

## Build

Requirements: JDK 21, Android SDK with platform `android-36` and build-tools `36.0.0`. Point the build at the SDK with
`ANDROID_HOME`, `ANDROID_SDK_ROOT`, or a `local.properties` with `sdk.dir`.

```bash
cd packages/android
./gradlew :app:assembleDebug          # builds packages/app itself, then assembles
# app/build/outputs/apk/debug/app-debug.apk
```

The web bundle is a build input and is never committed: it is about 35 MB over roughly 1600 files, and it has to be
built with this app's server mode. `app/build.gradle.kts` runs `bun run build` in `packages/app` with
`VITE_ORCHESTRA_SERVER_MODE=none` and `ORCHESTRA_CHANNEL=beta`, then copies the result into
`app/build/generated/webAssets`. To use a bundle built elsewhere, for example when the web build is a separate CI step:

```bash
bun run --cwd packages/app build
./gradlew :app:assembleDebug -PwebBundleDir=../app/dist
```

`./gradlew :app:assembleDebug -PversionCode=20025` rebuilds one release without changing its version name.

## Signing

Debug builds are signed with the AGP debug keystore. No key or password lives in this tree. A release build is signed
only when these environment variables are present, and stays unsigned otherwise:

| Variable | Meaning |
| --- | --- |
| `ORCHESTRA_ANDROID_KEYSTORE` | path to the keystore file |
| `ORCHESTRA_ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ORCHESTRA_ANDROID_KEY_ALIAS` | key alias |
| `ORCHESTRA_ANDROID_KEY_PASSWORD` | key password |

## What this app is not

- It does not run the agent. The server does; the phone sends prompts and shows the stream.
- It has no offline mode. With no server reachable the app is an empty connection form.
- The server password is kept in the WebView's `localStorage`, in plain text inside the app's private storage. Moving it
  to the Android keychain is a separate task.
- There are no push notifications. A backgrounded WebView is not woken by anything but the system.
- The APK version and the server version can drift apart, because the bundle is built ahead of the server it will talk
  to.
