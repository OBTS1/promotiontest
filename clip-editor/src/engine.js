// 動画のカットとつなぎ合わせ（再エンコードなし）。
// 各クリップの moov だけを読み込んでサンプル表を作り、選んだ範囲のサンプルを並べ直して
// 新しい moov を組み立てる。映像・音声データ本体は Blob.slice で元ファイルを参照するだけなので、
// メモリをほとんど使わず、画質も変わらない。
// 映像は再エンコードしないため、開始位置はキーフレーム（Iフレーム）に合わせる。
(function (root) {
  'use strict';

  var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, edts: 1, dinf: 1, mvex: 1 };
  var MAX32 = 0xffffffff;
  var EPS = 1e-6;

  function fail(message) {
    var e = new Error(message);
    e.userFacing = true;
    throw e;
  }

  // ---------- 読み込み ----------

  function fourcc(bytes, at) {
    return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  }

  async function readBytes(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  async function scanTopLevel(blob) {
    var boxes = [];
    var pos = 0;
    var total = blob.size;
    while (pos + 8 <= total) {
      var h = await readBytes(blob, pos, Math.min(pos + 16, total));
      var dv = new DataView(h.buffer);
      var size = dv.getUint32(0);
      var type = fourcc(h, 4);
      var header = 8;
      if (size === 1) {
        if (h.length < 16) fail('ファイルの末尾が壊れています。');
        size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
        header = 16;
      } else if (size === 0) {
        size = total - pos;
      }
      if (size < header || pos + size > total) {
        if (type !== 'mdat') fail('ファイルが途中で切れているか、MP4/MOV 形式ではありません。');
        size = total - pos;
      }
      boxes.push({ type: type, start: pos, size: size, header: header });
      pos += size;
    }
    return boxes;
  }

  function parseTree(bytes, start, end) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var out = [];
    var pos = start;
    while (pos + 8 <= end) {
      var size = dv.getUint32(pos);
      var type = fourcc(bytes, pos + 4);
      var header = 8;
      if (size === 1) {
        size = dv.getUint32(pos + 8) * 4294967296 + dv.getUint32(pos + 12);
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header || pos + size > end) fail('動画の情報部分（moov）が壊れています。');
      var box = { type: type, start: pos, size: size, header: header, bytes: bytes };
      if (CONTAINERS[type]) box.children = parseTree(bytes, pos + header, pos + size);
      out.push(box);
      pos += size;
    }
    return out;
  }

  function child(box, type) {
    if (!box || !box.children) return null;
    for (var i = 0; i < box.children.length; i++) if (box.children[i].type === type) return box.children[i];
    return null;
  }

  function payload(box) {
    return new DataView(box.bytes.buffer, box.bytes.byteOffset + box.start + box.header, box.size - box.header);
  }

  function u64(dv, at) {
    return dv.getUint32(at) * 4294967296 + dv.getUint32(at + 4);
  }

  function i64(dv, at) {
    return dv.getInt32(at) * 4294967296 + dv.getUint32(at + 4);
  }

  function parseTrack(trak) {
    var mdia = child(trak, 'mdia');
    var hdlrBox = child(mdia, 'hdlr');
    var mdhdBox = child(mdia, 'mdhd');
    var tkhdBox = child(trak, 'tkhd');
    var stbl = child(child(mdia, 'minf'), 'stbl');
    if (!hdlrBox || !mdhdBox || !tkhdBox || !stbl) return null;

    var kind = fourcc(new Uint8Array(payload(hdlrBox).buffer, payload(hdlrBox).byteOffset + 8, 4), 0);
    var mdhd = payload(mdhdBox);
    var mv = mdhd.getUint8(0);
    var timescale = mv === 1 ? mdhd.getUint32(20) : mdhd.getUint32(12);
    var lang = mv === 1 ? mdhd.getUint16(32) : mdhd.getUint16(20);

    var tkhd = payload(tkhdBox);
    var mOff = tkhd.getUint8(0) === 1 ? 52 : 40;
    var matrix = new Uint8Array(tkhd.buffer.slice(tkhd.byteOffset + mOff, tkhd.byteOffset + mOff + 36));
    var tkWidth = tkhd.getUint32(mOff + 36);
    var tkHeight = tkhd.getUint32(mOff + 40);

    // 編集リストの最初の有効な区間が、表示開始位置（メディア時間）
    var shift = 0;
    var elstBox = child(child(trak, 'edts'), 'elst');
    if (elstBox) {
      var el = payload(elstBox);
      var ev = el.getUint8(0);
      var en = el.getUint32(4);
      var at = 8;
      for (var e = 0; e < en; e++) {
        var mt = ev === 1 ? i64(el, at + 8) : el.getInt32(at + 4);
        at += ev === 1 ? 20 : 12;
        if (mt !== -1) { shift = mt; break; }
      }
    }

    // サンプル記述（コーデック設定）をそのまま保持する
    var stsdBox = child(stbl, 'stsd');
    if (!stsdBox) return null;
    var entries = [];
    var sp = stsdBox.start + stsdBox.header + 8;
    var sEnd = stsdBox.start + stsdBox.size;
    var sdv = new DataView(stsdBox.bytes.buffer, stsdBox.bytes.byteOffset);
    while (sp + 8 <= sEnd) {
      var esz = sdv.getUint32(sp);
      if (esz < 8 || sp + esz > sEnd) break;
      entries.push(stsdBox.bytes.slice(sp, sp + esz));
      sp += esz;
    }
    if (!entries.length) return null;

    // サンプルサイズ
    var count, size;
    var stsz = child(stbl, 'stsz');
    var stz2 = child(stbl, 'stz2');
    if (stsz) {
      var p = payload(stsz);
      var uniform = p.getUint32(4);
      count = p.getUint32(8);
      size = new Uint32Array(count);
      for (var i = 0; i < count; i++) size[i] = uniform || p.getUint32(12 + i * 4);
    } else if (stz2) {
      var q = payload(stz2);
      var field = q.getUint8(7);
      count = q.getUint32(8);
      size = new Uint32Array(count);
      for (var j = 0; j < count; j++) {
        if (field === 16) size[j] = q.getUint16(12 + j * 2);
        else if (field === 8) size[j] = q.getUint8(12 + j);
        else { var b = q.getUint8(12 + (j >> 1)); size[j] = j & 1 ? b & 15 : b >> 4; }
      }
    } else {
      return null;
    }

    // 再生時間（stts）
    var dur = new Uint32Array(count);
    var sttsBox = child(stbl, 'stts');
    if (sttsBox) {
      var st = payload(sttsBox);
      var sn = st.getUint32(4);
      var k = 0;
      for (var r = 0; r < sn && k < count; r++) {
        var c = st.getUint32(8 + r * 8), d = st.getUint32(12 + r * 8);
        for (var x = 0; x < c && k < count; x++) dur[k++] = d;
      }
    }

    // 表示時刻のずれ（ctts、Bフレームがある場合）
    var cto = new Int32Array(count);
    var cttsBox = child(stbl, 'ctts');
    if (cttsBox) {
      var ct = payload(cttsBox);
      var cn = ct.getUint32(4);
      var m = 0;
      for (var s = 0; s < cn && m < count; s++) {
        var cc = ct.getUint32(8 + s * 8), co = ct.getInt32(12 + s * 8);
        for (var y = 0; y < cc && m < count; y++) cto[m++] = co;
      }
    }

    // キーフレーム（stss が無ければ全サンプルがキーフレーム）
    var sync = new Uint8Array(count);
    var stssBox = child(stbl, 'stss');
    if (stssBox) {
      var ss = payload(stssBox);
      var sc = ss.getUint32(4);
      for (var t = 0; t < sc; t++) {
        var n1 = ss.getUint32(8 + t * 4);
        if (n1 >= 1 && n1 <= count) sync[n1 - 1] = 1;
      }
    } else {
      sync.fill(1);
    }

    // チャンク位置 → サンプルごとのファイル内位置
    var chunkOff = [];
    var stco = child(stbl, 'stco');
    var co64 = child(stbl, 'co64');
    if (stco) {
      var o = payload(stco);
      var on = o.getUint32(4);
      for (var z = 0; z < on; z++) chunkOff.push(o.getUint32(8 + z * 4));
    } else if (co64) {
      var o6 = payload(co64);
      var on6 = o6.getUint32(4);
      for (var z6 = 0; z6 < on6; z6++) chunkOff.push(u64(o6, 8 + z6 * 8));
    } else {
      return null;
    }
    var runs = [];
    var stscBox = child(stbl, 'stsc');
    if (stscBox) {
      var sc2 = payload(stscBox);
      var rn = sc2.getUint32(4);
      for (var w = 0; w < rn; w++) {
        runs.push({ first: sc2.getUint32(8 + w * 12), per: sc2.getUint32(12 + w * 12), desc: sc2.getUint32(16 + w * 12) });
      }
    }
    var offset = new Float64Array(count);
    var desc = new Uint16Array(count);
    var si = 0, ri = 0;
    for (var ch = 0; ch < chunkOff.length && si < count; ch++) {
      while (ri + 1 < runs.length && runs[ri + 1].first <= ch + 1) ri++;
      var run = runs[ri] || { per: 1, desc: 1 };
      var pos = chunkOff[ch];
      for (var u = 0; u < run.per && si < count; u++) {
        offset[si] = pos;
        desc[si] = Math.min(Math.max(run.desc - 1, 0), entries.length - 1);
        pos += size[si];
        si++;
      }
    }

    var dts = new Float64Array(count);
    var acc = 0;
    for (var v = 0; v < count; v++) { dts[v] = acc; acc += dur[v]; }

    var e0 = entries[0];
    var edv = new DataView(e0.buffer, e0.byteOffset, e0.byteLength);
    var info = {
      kind: kind, timescale: timescale, lang: lang, matrix: matrix, tkWidth: tkWidth, tkHeight: tkHeight,
      shift: shift, entries: entries, codec: fourcc(e0, 4), count: count, size: size, dur: dur, cto: cto,
      sync: sync, offset: offset, desc: desc, dts: dts, total: acc
    };
    if (kind === 'vide' && e0.length >= 36) { info.width = edv.getUint16(32); info.height = edv.getUint16(34); }
    if (kind === 'soun' && e0.length >= 28) { info.channels = edv.getUint16(24); }
    return info;
  }

  // [k, m) と [m, 次のキーフレーム) の表示時刻が重ならなければ、m で切っても表示に穴が空かない
  function cleanCut(T, k, m) {
    var maxIn = -Infinity, minOut = Infinity, i;
    for (i = k; i < m; i++) maxIn = Math.max(maxIn, T.dts[i] + T.cto[i]);
    for (i = m; i < T.count && (i === m || !T.sync[i]); i++) minOut = Math.min(minOut, T.dts[i] + T.cto[i]);
    return maxIn < minOut;
  }

  function pts(T, i) {
    return (T.dts[i] + T.cto[i] - T.shift) / T.timescale;
  }

  /** 動画ファイルを読み込み、編集に必要な情報を返す */
  async function openClip(file) {
    var top = await scanTopLevel(file);
    var moovInfo = null, ftypInfo = null;
    for (var i = 0; i < top.length; i++) {
      if (top[i].type === 'moov') moovInfo = top[i];
      if (top[i].type === 'ftyp' && !ftypInfo) ftypInfo = top[i];
      if (top[i].type === 'moof') fail('分割形式（fragmented MP4）の動画にはまだ対応していません。');
    }
    if (!moovInfo) fail('MP4/MOV の動画として読み込めませんでした。');
    var moovBytes = await readBytes(file, moovInfo.start, moovInfo.start + moovInfo.size);
    var moov = parseTree(moovBytes, 0, moovBytes.length)[0];
    var ftyp = ftypInfo ? await readBytes(file, ftypInfo.start, ftypInfo.start + ftypInfo.size) : null;

    var video = null, audio = null;
    moov.children.forEach(function (b) {
      if (b.type !== 'trak') return;
      var t = parseTrack(b);
      if (!t || !t.count) return;
      if (t.kind === 'vide' && !video) video = t;
      if (t.kind === 'soun' && !audio) audio = t;
    });
    if (!video) fail('映像が入っていない動画です。');

    var keyTimes = [];
    for (var k = 0; k < video.count; k++) if (video.sync[k]) keyTimes.push(pts(video, k));
    keyTimes.sort(function (a, b) { return a - b; });

    var first = keyTimes.length ? Math.max(0, keyTimes[0]) : 0;
    return {
      file: file,
      name: file.name || 'video',
      ftyp: ftyp,
      video: video,
      audio: audio,
      duration: video.total / video.timescale,
      firstTime: first,
      keyTimes: keyTimes
    };
  }

  /** 指定時刻以前で最も近いキーフレームの時刻（実際の開始位置） */
  function snapStart(clip, t) {
    var best = clip.keyTimes[0] || 0;
    for (var i = 0; i < clip.keyTimes.length; i++) {
      if (clip.keyTimes[i] <= t + EPS) best = clip.keyTimes[i];
      else break;
    }
    return Math.max(0, best);
  }

  // ---------- 書き出し ----------

  function concat(parts) {
    var len = 0, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    var pos = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], pos); pos += parts[i].length; }
    return out;
  }

  function flat(list, out) {
    for (var i = 0; i < list.length; i++) {
      if (Array.isArray(list[i])) flat(list[i], out);
      else if (list[i]) out.push(list[i]);
    }
    return out;
  }

  function str(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    return b;
  }

  function u32s() {
    var b = new Uint8Array(arguments.length * 4);
    var dv = new DataView(b.buffer);
    for (var i = 0; i < arguments.length; i++) dv.setUint32(i * 4, arguments[i] >>> 0);
    return b;
  }

  function u16s() {
    var b = new Uint8Array(arguments.length * 2);
    var dv = new DataView(b.buffer);
    for (var i = 0; i < arguments.length; i++) dv.setUint16(i * 2, arguments[i]);
    return b;
  }

  function u64b(v) {
    return u32s(Math.floor(v / 4294967296), v % 4294967296);
  }

  function box(type) {
    var body = concat(flat(Array.prototype.slice.call(arguments, 1), []));
    return concat([u32s(body.length + 8), str(type), body]);
  }

  function full(type, version, flags) {
    var rest = Array.prototype.slice.call(arguments, 3);
    return box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), rest);
  }

  function table(values, width, signed) {
    var b = new Uint8Array(values.length * width);
    var dv = new DataView(b.buffer);
    for (var i = 0; i < values.length; i++) {
      if (width === 8) { dv.setUint32(i * 8, Math.floor(values[i] / 4294967296)); dv.setUint32(i * 8 + 4, values[i] % 4294967296); }
      else if (signed) dv.setInt32(i * 4, values[i]);
      else dv.setUint32(i * 4, values[i] >>> 0);
    }
    return b;
  }

  function runLength(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var last = out.length ? out[out.length - 1] : null;
      if (last && last[1] === values[i]) last[0]++;
      else out.push([1, values[i]]);
    }
    return out;
  }

  // ---------- HEVC のつなぎ目 ----------
  // HEVC のキーフレームが CRA（オープン GOP）だと、途中につなぐとデコーダが前の区間の続きとして扱ってしまう。
  // 規格上の「つなぎ目」用の種類 BLA に書き換えると、そこから独立して再生できる。

  function isHevc(codec) {
    return codec === 'hvc1' || codec === 'hev1' || codec === 'dvh1' || codec === 'dvhe';
  }

  function nalLengthSize(entry) {
    for (var i = 8; i + 8 + 22 <= entry.length; i++) {
      if (entry[i] === 104 && entry[i + 1] === 118 && entry[i + 2] === 99 && entry[i + 3] === 67) { // 'hvcC'
        return (entry[i + 4 + 21] & 3) + 1;
      }
    }
    return 4;
  }

  function craToBla(bytes, lengthSize) {
    var pos = 0;
    while (pos + lengthSize < bytes.length) {
      var len = 0;
      for (var i = 0; i < lengthSize; i++) len = len * 256 + bytes[pos + i];
      var h = pos + lengthSize;
      if (len < 2 || h + len > bytes.length) return;
      var type = (bytes[h] >> 1) & 63;
      if (type === 21) bytes[h] = (bytes[h] & 0x81) | (16 << 1); // CRA_NUT → BLA_W_LP
      pos = h + len;
    }
  }

  var IDENTITY = u32s(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function newTrackOut(T) {
    return { src: T, entries: [], dur: [], cto: [], size: [], sync: [], desc: [], off: [], total: 0 };
  }

  function descIndex(out, entry) {
    for (var i = 0; i < out.entries.length; i++) if (sameBytes(out.entries[i], entry)) return i;
    out.entries.push(entry);
    return out.entries.length - 1;
  }

  function stbl(out, isVideo, use64) {
    var n = out.size.length;
    var stts = runLength(out.dur);
    var parts = [];
    parts.push(full('stsd', 0, 0, u32s(out.entries.length), out.entries));
    parts.push(full('stts', 0, 0, u32s(stts.length), table([].concat.apply([], stts), 4)));

    var hasCto = out.cto.some(function (v) { return v !== 0; });
    if (hasCto) {
      var neg = out.cto.some(function (v) { return v < 0; });
      var ctts = runLength(out.cto);
      var flatC = [];
      ctts.forEach(function (r) { flatC.push(r[0], r[1]); });
      var cb = new Uint8Array(flatC.length * 4);
      var cdv = new DataView(cb.buffer);
      for (var i = 0; i < flatC.length; i++) {
        if (i % 2) cdv.setInt32(i * 4, flatC[i]); else cdv.setUint32(i * 4, flatC[i]);
      }
      parts.push(full('ctts', neg ? 1 : 0, 0, u32s(ctts.length), cb));
    }

    if (isVideo && out.sync.some(function (s) { return !s; })) {
      var idx = [];
      for (var s = 0; s < n; s++) if (out.sync[s]) idx.push(s + 1);
      parts.push(full('stss', 0, 0, u32s(idx.length), table(idx, 4)));
    }

    // 1サンプル = 1チャンク。記述（コーデック設定）が変わるところで stsc の行を足す
    var stsc = [];
    for (var c = 0; c < n; c++) {
      if (!stsc.length || stsc[stsc.length - 1][2] !== out.desc[c] + 1) stsc.push([c + 1, 1, out.desc[c] + 1]);
    }
    parts.push(full('stsc', 0, 0, u32s(stsc.length), table([].concat.apply([], stsc), 4)));

    var allSame = n > 0 && out.size.every(function (v) { return v === out.size[0]; });
    if (allSame) parts.push(full('stsz', 0, 0, u32s(out.size[0], n)));
    else parts.push(full('stsz', 0, 0, u32s(0, n), table(out.size, 4)));

    if (use64) parts.push(full('co64', 0, 0, u32s(n), table(out.off, 8)));
    else parts.push(full('stco', 0, 0, u32s(n), table(out.off, 4)));

    return box('stbl', parts);
  }

  function trak(out, id, isVideo, movieTs, base) {
    var T = out.src;
    var ts = out.timescale;
    var movieDur = Math.round(out.total * movieTs / ts);
    var tkhd = full('tkhd', 0, 3,
      u32s(0, 0, id, 0, movieDur, 0, 0),
      u16s(0, 0, isVideo ? 0 : 0x0100, 0),
      isVideo ? T.matrix : IDENTITY,
      u32s(isVideo ? T.tkWidth : 0, isVideo ? T.tkHeight : 0));

    // 先頭の表示時刻のずれを編集リストで打ち消し、0秒から表示されるようにする
    var mediaTime = isVideo && out.cto.length ? Math.max(0, out.cto[0]) : 0;
    var edts = box('edts', full('elst', 0, 0, u32s(1, movieDur, mediaTime, 0x00010000)));

    var mdhd = out.total > MAX32
      ? full('mdhd', 1, 0, u64b(0), u64b(0), u32s(ts), u64b(out.total), u16s(T.lang, 0))
      : full('mdhd', 0, 0, u32s(0, 0, ts, out.total), u16s(T.lang, 0));
    var hdlr = full('hdlr', 0, 0, u32s(0), str(isVideo ? 'vide' : 'soun'), u32s(0, 0, 0),
      str(isVideo ? 'VideoHandler\0' : 'SoundHandler\0'));
    var mhd = isVideo ? full('vmhd', 0, 1, u16s(0, 0, 0, 0)) : full('smhd', 0, 0, u16s(0, 0));
    var dinf = box('dinf', full('dref', 0, 0, u32s(1), full('url ', 0, 1)));
    var offsets = out.off;
    out.off = offsets.map(function (v) { return v + base; });
    var minf = box('minf', mhd, dinf, stbl(out, isVideo, out.use64));
    out.off = offsets;
    return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
  }

  var DEFAULT_FTYP = box('ftyp', str('mp42'), u32s(0), str('isom'), str('mp42'), str('mp41'));

  /**
   * segments: [{ clip, start, end }]（秒。start はキーフレームに合わせて使われる）
   * opts.mute: true で音声を入れない
   * 戻り値: { blob, duration, audio: 'kept' | 'muted' | 'dropped' }
   */
  async function render(segments, opts) {
    opts = opts || {};
    if (!segments.length) fail('クリップがありません。');
    var first = segments[0].clip;
    var V0 = first.video;

    segments.forEach(function (s, i) {
      var V = s.clip.video;
      if (V.codec !== V0.codec) fail((i + 1) + ' 番目のクリップは動画の形式（' + V.codec + '）が 1 番目（' + V0.codec + '）と違うため、つなげられません。');
      if (V.width !== V0.width || V.height !== V0.height) fail((i + 1) + ' 番目のクリップは解像度が 1 番目と違うため、つなげられません。');
      if (!sameBytes(V.matrix, V0.matrix)) fail((i + 1) + ' 番目のクリップは縦横の向きが 1 番目と違うため、つなげられません。');
    });

    var A0 = first.audio;
    var audioOk = !opts.mute && segments.every(function (s) {
      var A = s.clip.audio;
      return A && A0 && A.codec === A0.codec && A.timescale === A0.timescale && A.channels === A0.channels;
    });
    var audioState = opts.mute ? 'muted' : audioOk ? 'kept' : 'dropped';
    if (audioState === 'dropped' && !segments.some(function (s) { return s.clip.audio; })) audioState = 'none';

    var vo = newTrackOut(V0);
    vo.timescale = V0.timescale;
    var ao = audioOk ? newTrackOut(A0) : null;
    if (ao) ao.timescale = A0.timescale;

    var items = []; // { file, off, size, out, idx }
    var videoSec = 0;
    var audioUnits = 0;

    segments.forEach(function (seg) {
      var clip = seg.clip;
      var V = clip.video;

      // 開始：指定時刻以前のキーフレーム
      var k = -1, kFirst = -1;
      for (var i = 0; i < V.count; i++) {
        if (!V.sync[i]) continue;
        var p = pts(V, i);
        if (kFirst === -1 || p < pts(V, kFirst)) kFirst = i;
        if (p <= seg.start + EPS && (k === -1 || p > pts(V, k))) k = i;
      }
      if (k === -1) k = kFirst === -1 ? 0 : kFirst;
      var startSec = pts(V, k);
      var limit = (seg.end - startSec) * V.timescale;
      var m = k;
      while (m < V.count && V.dts[m] - V.dts[k] < limit - EPS) m++;
      if (m === k) m = k + 1;
      // Bフレームがあると、デコード順の途中で切ると表示順に穴が空く。
      // 「ここまでの表示時刻がすべて、残りの表示時刻より前」になる位置まで終わりを延ばす
      while (m < V.count && !V.sync[m] && !cleanCut(V, k, m)) m++;

      var segItems = [];
      var inAcc = 0, outPrev = 0;
      var scale = vo.timescale / V.timescale;
      var kPts = V.dts[k] + V.cto[k];
      for (var j = k; j < m; j++) {
        // キーフレームより前に表示されるフレーム（前の区間を参照する）は入れない
        if (j > k && V.dts[j] + V.cto[j] < kPts) continue;
        var d;
        if (scale === 1) d = V.dur[j];
        else { inAcc += V.dur[j]; var oc = Math.round(inAcc * scale); d = oc - outPrev; outPrev = oc; }
        var idx = vo.size.length;
        vo.dur.push(d);
        vo.cto.push(scale === 1 ? V.cto[j] : Math.round(V.cto[j] * scale));
        vo.size.push(V.size[j]);
        vo.sync.push(j === k ? 1 : V.sync[j]);
        vo.desc.push(descIndex(vo, V.entries[V.desc[j]]));
        vo.off.push(0);
        vo.total += d;
        segItems.push({ file: clip.file, off: V.offset[j], size: V.size[j], out: vo, idx: idx,
          patch: j === k && isHevc(V.codec) ? nalLengthSize(V.entries[V.desc[j]]) : 0 });
      }
      videoSec = vo.total / vo.timescale;

      if (ao) {
        var A = clip.audio;
        var a = 0;
        while (a < A.count && pts(A, a) < startSec - EPS) a++;
        // 映像の合計時間に音声の合計時間がいちばん近くなるところまで入れる（つなぎ目でずれが溜まらない）
        var target = videoSec * ao.timescale;
        while (a < A.count && audioUnits + A.dur[a] / 2 < target) {
          var ai = ao.size.length;
          ao.dur.push(A.dur[a]);
          ao.cto.push(A.cto[a]);
          ao.size.push(A.size[a]);
          ao.sync.push(1);
          ao.desc.push(descIndex(ao, A.entries[A.desc[a]]));
          ao.off.push(0);
          ao.total += A.dur[a];
          audioUnits += A.dur[a];
          segItems.push({ file: clip.file, off: A.offset[a], size: A.size[a], out: ao, idx: ai });
          a++;
        }
      }

      // 元ファイルでの並び順のまま書き出す（連続した範囲をまとめて参照できる）
      segItems.sort(function (x, y) { return x.off - y.off; });
      for (var q = 0; q < segItems.length; q++) items.push(segItems[q]);
    });

    var dataSize = 0;
    var ranges = [];
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      it.out.off[it.idx] = dataSize;
      dataSize += it.size;
      if (it.patch) {
        // 区間の先頭フレームだけは読み込んで書き換える（つなぎ目の HEVC 対策）
        var bytes = await readBytes(it.file, it.off, it.off + it.size);
        craToBla(bytes, it.patch);
        ranges.push({ bytes: bytes });
        continue;
      }
      var last = ranges[ranges.length - 1];
      if (last && !last.bytes && last.file === it.file && last.end === it.off) last.end += it.size;
      else ranges.push({ file: it.file, start: it.off, end: it.off + it.size });
    }

    var ftyp = first.ftyp || DEFAULT_FTYP;
    var bigMdat = dataSize + 8 > MAX32;
    var mdatHeaderSize = bigMdat ? 16 : 8;
    var use64 = ftyp.length + dataSize + mdatHeaderSize + 64 * 1048576 > MAX32;
    vo.use64 = use64;
    if (ao) ao.use64 = use64;

    var movieTs = 1000;
    function buildMoov(base) {
      var tracks = [trak(vo, 1, true, movieTs, base)];
      if (ao && ao.size.length) tracks.push(trak(ao, 2, false, movieTs, base));
      var movieDur = Math.max(Math.round(vo.total * movieTs / vo.timescale), ao ? Math.round(ao.total * movieTs / ao.timescale) : 0);
      var mvhd = full('mvhd', 0, 0,
        u32s(0, 0, movieTs, movieDur, 0x00010000),
        u16s(0x0100, 0), u32s(0, 0),
        IDENTITY,
        u32s(0, 0, 0, 0, 0, 0),
        u32s(tracks.length + 1));
      return box('moov', mvhd, tracks);
    }
    var sized = buildMoov(0);
    var base = ftyp.length + sized.length + mdatHeaderSize;
    var moov = buildMoov(base);

    var mdatHeader = bigMdat
      ? concat([u32s(1), str('mdat'), u64b(dataSize + 16)])
      : concat([u32s(dataSize + 8), str('mdat')]);

    var parts = [ftyp, moov, mdatHeader];
    ranges.forEach(function (r) { parts.push(r.bytes || r.file.slice(r.start, r.end)); });
    return {
      blob: new Blob(parts, { type: 'video/mp4' }),
      duration: vo.total / vo.timescale,
      audio: audioState
    };
  }

  var api = { openClip: openClip, snapStart: snapStart, render: render };
  root.ClipEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
