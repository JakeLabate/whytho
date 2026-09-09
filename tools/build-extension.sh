#!/usr/bin/env bash
# Keeps the packaged annotator identical to the hosted one, then zips the extension.
# Manifest v3 forbids remote code, so the extension ships its own copy and this
# script is the only thing preventing the two from drifting apart.
set -e
cd "$(dirname "$0")/.."
cp assets/annotator.js extension/annotator.js
VERSION=$(grep -o "VERSION = '[0-9.]*'" assets/annotator.js | head -1 | grep -o "[0-9.]*")
python3 - "$VERSION" <<'PY'
import json, sys, pathlib
v = sys.argv[1]
p = pathlib.Path('extension/manifest.json')
m = json.loads(p.read_text())
m['version'] = v if v.count('.') == 2 else v + '.0'
p.write_text(json.dumps(m, indent=2) + '\n')
print('manifest version ->', m['version'])
PY
rm -f whytho-extension.zip
cd extension && zip -qr ../whytho-extension.zip . -x '.*' && cd ..
echo "packed $(du -h whytho-extension.zip | cut -f1)"
