// 各ツールのページ（Artifact 用の本文）を完全な HTML に包み、アイコンとサービスワーカーを添えて docs/ に出力する
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs');
fs.mkdirSync(path.join(out, 'clip-editor'), { recursive: true });
fs.mkdirSync(path.join(out, 'mute-video'), { recursive: true });

function page(body, depth, withHome) {
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
<meta name="apple-mobile-web-app-title" content="動画ツール">
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

// アイコン（SVG → PNG）は Playwright の Chromium で描く
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const pw = execSync('npm root -g').toString().trim() + '/playwright';
(async () => {
  const { chromium } = require(pw);
  const b = await chromium.launch();
  for (const size of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await p.screenshot({ path: path.join(out, `icon-${size}.png`) });
    await p.close();
  }
  await b.close();

  // 中身が変わったらキャッシュ名も変わるようにする
  const hash = crypto.createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(files[name]);
  hash.update(svg);
  const sw = fs.readFileSync(path.join(__dirname, 'sw.template.js'), 'utf8').replace('__VERSION__', hash.digest('hex').slice(0, 12));
  fs.writeFileSync(path.join(out, 'sw.js'), sw);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log('built docs/');
})();
