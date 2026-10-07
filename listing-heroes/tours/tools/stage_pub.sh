#!/usr/bin/env bash
# Copy dist/<slug> (resolved, no symlinks) into a publish folder and print the Artifact files map.
#   tools/stage_pub.sh <slug> <pubroot>
set -euo pipefail
cd "$(dirname "$0")/.."
s=$1; P=$2
rm -rf "$P/$s"; mkdir -p "$P/$s"
cp dist/$s/index.html "$P/$s/"
cp -rL dist/$s/media "$P/$s/media"
[ -e dist/$s/assets ] && cp -rL dist/$s/assets "$P/$s/assets"
python3 - "$P" "$s" <<'PY'
import json, os, sys
P, s = sys.argv[1:]
m = {}
for sub in ('media', 'assets'):
    d = os.path.join(P, s, sub)
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)): m[f'{sub}/{f}'] = f'{s}/{sub}/{f}'
print(json.dumps(m))
PY
