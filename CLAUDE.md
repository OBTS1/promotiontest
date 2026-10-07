# promotiontest

iPhone で使う個人用の Web アプリ置き場。持ち主は iPhone から Claude に依頼してアプリを作っている（Mac は使わない）。

## 公開先

- GitHub Pages（`main` ブランチの `docs/` フォルダ）: https://obts1.github.io/promotiontest/
- `docs/` はホーム画面に追加して使うオフライン対応アプリ「動画ツール」。メニュー（`docs/index.html`）から各ツールへ移動する。
- `docs/photo-upscale/` は別アプリ「写真の高画質化」（https://obts1.github.io/promotiontest/photo-upscale/）。アイコン・manifest・サービスワーカーを動画ツールと分けている。
- `docs/` は生成物なので直接編集しない。変更したら `./site/build.sh` で作り直してコミットする。

## 構成

| 場所 | 内容 |
|---|---|
| `clip-editor/src/engine.js` | 動画のカット・つなぎの処理（MP4/MOV を再エンコードせずに組み直す。縦横混在時は WebCodecs で 1080×1920 に再エンコード） |
| `clip-editor/src/page.html` | クリップつなぎの画面。`/*ENGINE*/` の位置に engine.js が埋め込まれる |
| `clip-editor/build.sh` | `clip-editor/index.html`（1 ファイル版）を作る |
| `mute-video/index.html` | 音声を消して保存するツール（1 ファイルで完結） |
| `photo-upscale/index.html` | 写真の高画質化（別アプリ）。「Gemini アプリで復元」は写真を共有シートで Gemini アプリに渡し、指示文をコピーする（持ち主の Gemini 契約内・追加料金なし）。結果を読み込むと元の比率に切りそろえて比べられる。「Gemini API で自動復元」は持ち主の API キーで直接送る（別料金）。「この端末で拡大」は同梱の ESRGAN（`models/`、TensorFlow.js は `vendor/`）で端末内処理 |
| `photo-upscale/` のその他 | 別アプリ用の icon.svg・manifest・sw.template.js。`site/build.cjs` が `docs/photo-upscale/` に出力する |
| `site/` | Pages 用のメニュー、manifest、アイコン、サービスワーカーの元と、`docs/` を作る `build.sh` |

## 方針

- 動画は端末の外に送らない。処理はすべてブラウザ内で行う。（例外：写真の高画質化の Gemini を使う方法は、持ち主の了承のうえで Google の Gemini に写真を送る。端末内だけの方法も残す）外部の CDN やフォントも読み込まない（オフラインで動かすため）。
- 画面は iPhone の縦持ち・Safari 前提。ライト／ダーク両対応。文言は日本語。
- 保存は、Claude の Artifact 内では `downloads` 機能、それ以外では共有シート（`navigator.share`）を使う。
- 同じオリジンでサービスワーカーが複数あるので、古いキャッシュを消すときは自分の名前（`video-tools-` / `photo-upscale-`）で始まるものだけを消す。
- 新しいツールを足すときは、単体で動く HTML を作り、`site/menu.html` にカードを、`site/build.cjs` と `site/sw.template.js` にファイルを追加する。

## 確認

- 動作確認は Playwright の Chromium で行う（`/opt/pw-browsers`）。この Chromium は H.264/HEVC の WebCodecs に非対応なので、再エンコードの確認は VP9 の素材で行う。
- 実機（iPhone）で試せないことは、試せていないと持ち主に伝える。
