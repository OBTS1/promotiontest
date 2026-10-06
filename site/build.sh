#!/bin/sh
# docs/ に GitHub Pages 用のオフライン対応アプリを作る
set -e
cd "$(dirname "$0")/.."
./clip-editor/build.sh
node site/build.cjs
