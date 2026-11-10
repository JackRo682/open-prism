Prism PDF export fonts

prism-export-korean-v1.ttf and prism-export-cjk-v1.ttf are renamed, unhinted TrueType conversions and subsets of Noto Sans CJK KR Regular from the system Noto CJK font collection (source: https://github.com/notofonts/noto-cjk). Both retain the SIL Open Font License in Noto-OFL.txt. The smaller font covers Korean Hangul/Jamo, Latin, kana, punctuation and supported mathematical symbols. The larger font includes all Unicode mappings and is fetched only when necessary.

DejaVuSans.ttf is an unchanged fallback font. Its Bitstream Vera license and copyright notice are in DejaVu-LICENSE.txt. Source: https://dejavu-fonts.github.io/

All font requests occur only during PDF export; pdf-lib subsets embedded PDF fonts to characters used in that document.

The CFF outlines were converted to quadratic TrueType outlines with fontTools Cu2QuPen (maximum deviation 1 / 1000 em, reversed contour direction). This avoids a CFF subsetting incompatibility in pdf-lib/fontkit. The original copyright/license metadata is retained; the internal family names are Prism Export Korean and Prism Export CJK.

Glyph records use two-byte padding so fontkit can safely write short loca offsets
when subsetting the TrueType font for individual conversation PDFs.

Source packaging: prism-export-cjk-v1.ttf is restored before dev/build from
assets/fonts/prism-export-cjk-v1.ttf.br. scripts/prepare-export-font.mjs checks
the exact decoded size and SHA-256 before writing the public asset. This is a
lossless representation of the same licensed font; glyphs and served bytes do
not change. To restore it manually: node scripts/prepare-export-font.mjs
