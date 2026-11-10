#!/usr/bin/env bash
set -euo pipefail

# This binary and checksum were verified against the publisher's v8.30.1 release.
# Updating the scanner requires a reviewed checksum change, never a "latest" URL.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) ;;
  *) echo "Automatic Gitleaks setup supports Linux x86_64. Install Gitleaks 8.30.1 and set GITLEAKS_BIN on other platforms." >&2; exit 69 ;;
esac
security_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.sites-runtime/security"
mkdir -p "${security_root}/bin"
security_download="$(mktemp -d "${security_root}/download.XXXXXX")"
trap 'rm -rf -- "${security_download}"' EXIT
curl --fail --location --silent --show-error --retry 2 --max-time 60 \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output "${security_download}/gitleaks.tar.gz"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "${security_download}/gitleaks.tar.gz" | sha256sum --check --status
tar -xzf "${security_download}/gitleaks.tar.gz" -C "${security_download}" gitleaks
install -m 0755 "${security_download}/gitleaks" "${security_root}/bin/gitleaks"
test "$("${security_root}/bin/gitleaks" version)" = '8.30.1'
echo 'Verified Gitleaks 8.30.1 is ready.'
