# Upload and private download protections

## Enforced by the application

- Text uploads contain exactly one nonempty file, at most 128 KiB. Supported
  text/source extensions are preserved, but every upload must decode as strict
  UTF-8 without binary control bytes. Filenames cannot contain paths, alternate
  stream separators, header controls, or bidirectional override characters.
- Uploaded source code is stored as plain text. The application does not import,
  evaluate, or execute it. File responses force attachment disposition and
  `text/plain`; generated work artifacts force `application/octet-stream` and
  attachment disposition. Download names are normalized and safely encoded.
- Reference images remain limited to 4 MiB and 2,048 pixels per side. Their
  filename extension, MIME declaration, and detected image structure must agree.
  PNG/JPEG/WebP files must have complete, bounded container structure, with no
  truncated chunks/segments, missing image data, or appended payload. Animated
  PNG/WebP and unsupported JPEG variants are rejected.
- PNG checks include chunk CRCs, permitted header values, chunk ordering,
  required image data/end markers, and bounded scanline decompression. The
  raster stream must exactly fit the declared dimensions, contain valid filter
  byte values, and pass zlib integrity checks. Expansion is stopped as soon as
  it exceeds that budget. The same check applies to generated PNG output, with
  its existing 4,096-pixel per-side limit.
- JPEG/WebP checks inspect the entire container and declared frame dimensions,
  including segment/chunk lengths, terminal markers, RIFF length, primary image
  payload, and metadata/part-count ceilings. They do not fully decode pixels.
- Media downloads only serve the specific raster/audio/video MIME types allowed
  for their media kind. They cannot be changed into an HTML/SVG response merely
  by changing stored MIME metadata. Download responses also carry `nosniff`,
  private `no-store`, a sandboxed CSP, and same-origin resource policy.
- Object access requires both an owned database row and an exact owned R2 key
  prefix. Media, references, and generated artifacts additionally require their
  proper namespace. The checks cover download, deletion, chat attachments,
  reference reuse, and bulk account-data deletion.

## Limits that remain

Container validation and PNG scanline decompression are not full semantic
pixel decoding or content disarm/reconstruction. PNG filter reconstruction and
palette values are not fully decoded; JPEG/WebP entropy streams are not decoded
by this Worker. These checks must not be described as antivirus scanning.

Before adding image transformations, document/PDF/archive parsing, or broader
file types, introduce a maintained decoder/scanning service in an isolated
runtime with explicit decoded-pixel, memory, CPU, wall-time, and network limits.
Only validated/re-encoded results should be promoted to user-visible storage.
No malware scanner or external content-scanning service is configured by this
patch. R2 bucket exposure and preview/production binding isolation must still
be verified in the hosting control plane.

## Verification

`tests/upload-security.test.mjs` covers genuine encoded images, corrupt and
truncated files, forged MIME, appended payloads, animation, container limits,
PNG compressed-stream checks and expansion bombs, strict UTF-8, filenames, and
owned key prefixes. `tests/upload-worker.test.mjs` exercises the same image
checks in native Workerd, including decompression cancellation. Route tests in
`tests/api-security.test.mjs` verify inert source downloads, multipart rejection,
wrong-owner object metadata, and unsafe stored MIME rejection before storage.

Primary references: [W3C PNG specification](https://www.w3.org/TR/png/),
[Google WebP container specification](https://developers.google.com/speed/webp/docs/riff_container),
and [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
