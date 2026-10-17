#!/bin/bash
# Maintainer script: build dist/ (+ optional demo video) and add a new commit on gh-pages (no force push). Token via temp GIT_ASKPASS.
set -e; cd "$(dirname "$0")/.."; ROOT=$PWD; node scripts/build-pages.js
[ -f ../video/trustrail-demo-v4.mp4 ] && cp ../video/trustrail-demo-v4.mp4 dist/demo.mp4
D=$(mktemp -d); git clone -q --branch gh-pages --single-branch https://github.com/northstar-trustrail/trustrail-hold.git "$D"
find "$D" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +; cp -r dist/. "$D"/; cd "$D"; git add -A
git diff --cached --quiet && { echo "nothing to deploy"; exit 0; }
git -c user.name=northstar-trustrail -c user.email=322945107+northstar-trustrail@users.noreply.github.com commit -qm "Deploy demo from main@$(git -C "$ROOT" rev-parse --short HEAD)"
A=$(mktemp /tmp/askpass.XXXXXX); printf '#!/bin/sh\ncase "$1" in *sername*) echo x-access-token;; *) echo "$BRAND_GITHUB_TOKEN";; esac\n' > "$A"; chmod 700 "$A"
GIT_ASKPASS="$A" GIT_TERMINAL_PROMPT=0 git push -q https://github.com/northstar-trustrail/trustrail-hold.git gh-pages 2>&1 | grep -v "^remote:" || true; rm -f "$A"; cd /; rm -rf "$D"; echo deployed
