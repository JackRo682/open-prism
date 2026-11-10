# Prism folded P mark

Original concept generated with the built-in image generation tool; clean production SVG drawn from that concept. The mark combines a bold P stem, a refracted upper plane, and an indigo return fold. The angular transparent counter keeps the mark legible in chat avatars and avoids the Gemini four-point star silhouette.

## Assets

- `prism-generated-concept.png`: original generated transparent concept.
- `../../public/brand/prism-mark.svg`: three-facet production vector with transparent background.
- `../../public/brand/prism-mark-{180,192,512}.png`: transparent installation and touch icons.
- `../../components/brand/prism-mark.tsx`: shared React implementation with unique gradient IDs.

SVG uses a 32 by 32 viewBox. Use 20–32 px for app controls and 32 px for response avatars. No raster dependencies are needed in the app. For inline React reuse, use `useId()` to prefix gradient IDs when more than one logo is present; external SVG `<img>` sources isolate IDs automatically.

## Generation prompt

Use case: logo-brand. Create ONE original icon mark for Prism, an AI chat workspace, on a genuinely transparent background. Minimal geometric folded ribbon forming a capital P monogram, with a bold upright stem and an angular open bowl; the inside counter should be generous transparent negative space so it reads at 20–32 pixels. Three clean faceted planes, flat precise vector-like silhouette, softly eased corners, elegant balanced proportions. Cyan to blue to deep indigo on the facets, restrained subtle gradients, strong contrast on both white and charcoal interfaces. Center the single mark on a square canvas with modest clear padding. This is a production brand icon, not a mockup or illustration. No words, no extra letters, no border, no background tile, no shadow, no texture, no glossy 3D effects. Avoid stars, sparkles, four-point diamonds, circular knots, or any Gemini-like silhouette. Make the P distinctive through a folded prism/ribbon structure, while keeping it simple and legible.
