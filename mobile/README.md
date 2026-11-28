# GetOpenPrism mobile

The Android, iOS and web development targets share `App.tsx`. The first screen opens the live web chat in the system browser. Native sign-in, conversations and billing are future features.

## Develop with ChatGPT Work

Open the `JackRo682/open-prism` repository and select the branch containing this directory. In Work, name the branch and request a change to `mobile/`. For example, “Add a native conversation list to GetOpenPrism mobile and run the mobile checks.” Select the coding model in Work's model picker. This project requires no OpenAI API key for coding or previewing.

## Run the app

With Node 24 LTS, open a terminal in `mobile/`:

```sh
npm ci
npm run web
```

The browser preview runs on port 8081 with Fast Refresh. From a GitHub Codespace, select the GetOpenPrism mobile dev container and open forwarded port 8081. Keep the forwarded port private. Expo Go on a physical device uses `npm start` on a computer on the same LAN. Scan its QR code using a matching Expo Go version. On a physical iPhone sign in to Expo Go and Expo CLI with the same Expo account. A forwarded Codespaces browser port is for the web preview.

## Verify a change

```sh
npm run typecheck
npm run check:expo
npm run export
```

The export creates Android and iOS JavaScript bundles and a static web build under `dist/`. For a local Android emulator use `npm run android` with Android Studio's emulator running. For the iOS simulator use `npm run ios` on macOS with Xcode.

## Native development builds

For custom native modules, use the included `expo-dev-client` and the development profile in `eas.json`. To link an Expo account for cloud builds, run `npx eas-cli@27.11.0 init` from `mobile/`, then `npx eas-cli@27.11.0 build --profile development --platform android` (or `ios`). Run `npm run start:dev` after installing the development build. Device builds for iOS need signing credentials. The preview and production profiles are available for later distribution. The proposed native identifier is `com.getopenprism.app` on both platforms.
