#!/bin/sh
# src/page.html の /*ENGINE*/ を src/engine.js に置き換えて、1ファイルの index.html を作る
set -e
cd "$(dirname "$0")"
node -e "
const fs=require('fs');
const page=fs.readFileSync('src/page.html','utf8');
const engine=fs.readFileSync('src/engine.js','utf8');
fs.writeFileSync('index.html', page.replace('/*ENGINE*/', () => engine));
"
