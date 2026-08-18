#!/usr/bin/env bash
# Bundle @canton-network/dapp-sdk into backend/public/canton-dapp-sdk.js.
#
# backend/public/index.html is one 3700-line file with React inlined, no `import`
# statements and no bundler. An npm ESM package cannot be dropped into it. So the
# SDK is bundled ONCE, here, into a browser IIFE that the page loads with a plain
# <script> tag -- the app keeps its no-build-step property.
#
# @walletconnect/sign-client is declared optional by the SDK but esbuild resolves
# imports statically, so it must be installed or the bundle fails to build.
#
# Run:  cd sdk-build && ./build.sh     (output is committed; this is not in any
#                                       serve or start path)
set -euo pipefail
cd "$(dirname "$0")"

OUT=../backend/public/canton-dapp-sdk.js
OUT_CONSOLE=../backend/public/console-wallet-sdk.js

[ -d node_modules ] || npm install

./node_modules/.bin/esbuild entry.js \
  --bundle \
  --format=iife \
  --global-name=CantonDapp \
  --platform=browser \
  --minify \
  --outfile="$OUT"

printf 'wrote %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"

# Console Wallet's SDK, bundled for the same reason plus one of its own: its ESM
# entry imports styles.css, which a browser refuses to load as a module script.
./node_modules/.bin/esbuild entry-console.js \
  --bundle \
  --format=iife \
  --global-name=ConsoleWalletSDK \
  --platform=browser \
  --minify \
  --loader:.css=text \
  --loader:.png=dataurl \
  --loader:.svg=dataurl \
  --loader:.jpg=dataurl \
  --loader:.gif=dataurl \
  --outfile="$OUT_CONSOLE"

printf 'wrote %s (%s)\n' "$OUT_CONSOLE" "$(du -h "$OUT_CONSOLE" | cut -f1)"
