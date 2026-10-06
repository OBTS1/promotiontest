# promotiontest

iPhone で使う個人用の Web アプリ置き場。持ち主は iPhone から Claude に依頼してアプリを作っている（Mac は使わない）。

## 公開先

- GitHub Pages（`main` ブランチの `docs/` フォルダ）: https://obts1.github.io/promotiontest/
- `docs/` はホーム画面に追加して使うオフライン対応アプリ「動画ツール」。メニュー（`docs/index.html`）から各ツールへ移動する。
- `docs/` は生成物なので直接編集しない。変更したら `./site/build.sh` で作り直してコミットする。

## 構成

| 場所 | 内容 |
|---|---|
| `clip-editor/src/engine.js` | 動画のカット・つなぎの処理（MP4/MOV を再エンコードせずに組み直す。縦横混在時は WebCodecs で 1080×1920 に再エンコード） |
| `clip-editor/src/page.html` | クリップつなぎの画面。`/*ENGINE*/` の位置に engine.js が埋め込まれる |
| `clip-editor/build.sh` | `clip-editor/index.html`（1 ファイル版）を作る |
| `mute-video/index.html` | 音声を消して保存するツール（1 ファイルで完結） |
| `site/` | Pages 用のメニュー、manifest、アイコン、サービスワーカーの元と、`docs/` を作る `build.sh` |

## 方針

- 動画は端末の外に送らない。処理はすべてブラウザ内で行う。外部の CDN やフォントも読み込まない（オフラインで動かすため）。
- 画面は iPhone の縦持ち・Safari 前提。ライト／ダーク両対応。文言は日本語。
- 保存は、Claude の Artifact 内では `downloads` 機能、それ以外では共有シート（`navigator.share`）を使う。
- 新しいツールを足すときは、単体で動く HTML を作り、`site/menu.html` にカードを、`site/build.cjs` と `site/sw.template.js` にファイルを追加する。

## 確認

- 動作確認は Playwright の Chromium で行う（`/opt/pw-browsers`）。この Chromium は H.264/HEVC の WebCodecs に非対応なので、再エンコードの確認は VP9 の素材で行う。
- 実機（iPhone）で試せないことは、試せていないと持ち主に伝える。
