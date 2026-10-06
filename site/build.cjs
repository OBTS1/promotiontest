// 各ツールのページ（Artifact 用の本文）を完全な HTML に包み、アイコンとサービスワーカーを添えて docs/ に出力する
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs');
fs.mkdirSync(path.join(out, 'clip-editor'), { recursive: true });
fs.mkdirSync(path.join(out, 'mute-video'), { recursive: true });

function page(body, depth, withHome, appName = '動画ツール') {
  const up = depth ? '../' : './';
  const home = withHome
    ? `<a href="${up}" style="display:inline-block;margin:12px 16px 0;padding:8px 2px;color:var(--accent,#1f5fd1);font:600 15px/1.2 system-ui,sans-serif;text-decoration:none">‹ ツール一覧</a>\n`
    : '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${appName}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="${up}manifest.webmanifest">
<link rel="apple-touch-icon" href="${up}icon-180.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}img{max-width:100%}</style>
</head>
<body>
${home}${body}
<script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('${up}sw.js', { scope: '${up}' }).catch(function () {});</script>
</body>
</html>
`;
}

const files = {
  'index.html': page(fs.readFileSync(path.join(__dirname, 'menu.html'), 'utf8'), 0, false),
  'clip-editor/index.html': page(fs.readFileSync(path.join(root, 'clip-editor/index.html'), 'utf8'), 1, true),
  'mute-video/index.html': page(fs.readFileSync(path.join(root, 'mute-video/index.html'), 'utf8'), 1, true),
  'manifest.webmanifest': fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8'),
};
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text);

// 別アプリ「写真の高画質化」：ホーム画面のアイコン・manifest・サービスワーカーを分ける（docs/photo-upscale/）
const photoSrc = path.join(root, 'photo-upscale');
const photoOut = path.join(out, 'photo-upscale');
const photoFiles = {
  'index.html': page(fs.readFileSync(path.join(photoSrc, 'index.html'), 'utf8'), 0, false, '高画質化'),
  'manifest.webmanifest': fs.readFileSync(path.join(photoSrc, 'manifest.webmanifest'), 'utf8'),
};
const photoCopies = ['vendor/tf.min.js', 'models/LICENSE', 'models/x2/model.json', 'models/x2/group1-shard1of1.bin',
  'models/x4/model.json', 'models/x4/group1-shard1of1.bin'];
for (const [name, text] of Object.entries(photoFiles)) {
  fs.mkdirSync(path.dirname(path.join(photoOut, name)), { recursive: true });
  fs.writeFileSync(path.join(photoOut, name), text);
}
for (const name of photoCopies) {
  fs.mkdirSync(path.dirname(path.join(photoOut, name)), { recursive: true });
  fs.copyFileSync(path.join(photoSrc, name), path.join(photoOut, name));
}

// アイコン（SVG → PNG）は Playwright の Chromium で描く
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const photoSvg = fs.readFileSync(path.join(photoSrc, 'icon.svg'), 'utf8');
const pw = execSync('npm root -g').toString().trim() + '/playwright';

async function icons(b, svgText, dir) {
  for (const size of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svgText}`);
    await p.screenshot({ path: path.join(dir, `icon-${size}.png`) });
    await p.close();
  }
}

// 中身が変わったらキャッシュ名も変わるようにする
function writeSw(template, dir, parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  const sw = fs.readFileSync(template, 'utf8').replace('__VERSION__', hash.digest('hex').slice(0, 12));
  fs.writeFileSync(path.join(dir, 'sw.js'), sw);
}

(async () => {
  const { chromium } = require(pw);
  const b = await chromium.launch();
  await icons(b, svg, out);
  await icons(b, photoSvg, photoOut);
  await b.close();

  writeSw(path.join(__dirname, 'sw.template.js'), out, [...Object.keys(files).sort().map((n) => files[n]), svg]);
  writeSw(path.join(photoSrc, 'sw.template.js'), photoOut, [
    ...Object.keys(photoFiles).sort().map((n) => photoFiles[n]),
    ...photoCopies.map((n) => fs.readFileSync(path.join(photoSrc, n))),
    photoSvg,
  ]);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log('built docs/');
})();
