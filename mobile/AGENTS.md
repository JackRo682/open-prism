# Mobile development

The native app lives in `mobile/` and uses Expo, React Native and TypeScript. Run mobile commands from that directory. Start with `npm ci`, use `npm run web` for interactive previews, and run `npm run typecheck`, `npm run check:expo` and `npm run export` when verifying changes. Read README.md in this directory for phone testing and build profiles.

The starter opens the existing GetOpenPrism website in the system browser. Its authentication session belongs to the browser. Keep model-provider credentials on the server when implementing native features.
