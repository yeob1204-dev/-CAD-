/* ===== DXF 내보내기 (7단계) =====
 * window.photoResults.getResults()에서 정상(OK)이고 DXF 좌표가 유효한 사진만 골라
 * 사진마다 POINT(PHOTO_POINT)와 파일명 TEXT(PHOTO_LABEL)를 만듭니다.
 * DXF 좌표: X = item.dxf.x (Easting), Y = item.dxf.y (Northing)  ※ 화면·CSV의 X/Y 순서와 다릅니다.
 * 형식: AutoCAD 2007(AC1021), UTF-8(BOM 없음), 단위 미터. 파일은 브라우저 안에서만 만들어지며 전송되지 않습니다.
 *
 * 외부 사진 연결(3단계): 설정 화면에서 '외부 사진 연결 방식'을 선택하면 DXF + thumbnails/ + originals/ + photo-index.html을
 * ZIP으로 저장합니다. GPS가 있고 썸네일(window.PhotoThumbnails)이 만들어진 사진마다 IMAGE/IMAGEDEF를 추가하며,
 * IMAGE의 왼쪽 아래 모서리가 촬영 좌표입니다. 사진 긴 변 = 설정한 사진 크기, 짧은 변은 원본 비율로 계산합니다.
 * 파일명 TEXT는 사진 위쪽(사진 윗변 + 간격)에 놓여 사진과 겹치지 않습니다. (ZIP 작성은 js/zip.js)
 *
 * 파일명 설정(4단계): 설정 화면에서 파일명 TEXT 표시를 켜고 끌 수 있고, 사진별로 CAD에 표시할 이름을 입력할 수 있습니다.
 * 이름은 File 객체에 연결되어 저장되며 CAD의 TEXT에만 적용됩니다(ZIP 안 파일명·CSV는 원본 그대로).
 */
(function () {
  'use strict';

  const btn = document.getElementById('dxf-btn');
  const note = document.querySelector('.footer-note');
  if (!btn) return;

  const LABEL_HEIGHT = 2.0;  // 글자 높이 (m)
  const LABEL_OFFSET = 2.0;  // POINT에서 X, Y 방향 간격 (m)
  const MAX_TEXT_LENGTH = 250;
  const DEFAULT_NOTE = note ? note.textContent : '';
  let noteTimer = null;

  function showNote(text) {
    if (!note) return;
    note.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { note.textContent = DEFAULT_NOTE; }, 6000);
  }

  // ---- DXF 쓰기 도구 ----
  function Writer() {
    this.lines = [];
    this.handle = 0x100; // 0x100 미만은 예약 (루트 사전 등)
  }
  Writer.prototype.next = function () { this.handle += 1; return this.handle.toString(16).toUpperCase(); };
  Writer.prototype.add = function (code, value) { this.lines.push(String(code), String(value)); };
  Writer.prototype.num = function (code, value) { this.add(code, Number(value).toFixed(6)); };

  // 파일명 → TEXT 문자열. 줄 구분 문자와 AutoCAD 특수 코드(%%, ^)가 깨지지 않도록 처리. 한글은 그대로 둠(UTF-8)
  function cleanText(name) {
    let t = String(name === null || name === undefined ? '' : name)
      .replace(/[\u0000-\u001F\u007F]+/g, ' ') // 줄바꿈 등 제어문자
      .replace(/%/g, '%%%')                     // %%d, %%c 같은 코드로 해석되지 않도록
      .replace(/\^/g, '^ ');                    // ^I 같은 제어 코드로 해석되지 않도록
    if (t.length > MAX_TEXT_LENGTH) t = t.slice(0, MAX_TEXT_LENGTH);
    return t;
  }

  function isValidItem(item) {
    return !!item && item.status === 'OK' && !!item.dxf &&
      typeof item.dxf.x === 'number' && isFinite(item.dxf.x) &&
      typeof item.dxf.y === 'number' && isFinite(item.dxf.y);
  }

  function numOr(v, fallback) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : fallback; }

  // items[i].image = { path, width, height } (썸네일 상대 경로와 픽셀 크기)가 있으면 그 사진에 IMAGE를 만든다.
  // items[i].label 이 있으면 TEXT에 원본 파일명 대신 그 이름을 쓴다.
  // options(설정 화면 값, 단위 m)가 없으면 기존 방식(글자 높이 2, 간격 2, IMAGE 없음) 그대로 만든다.
  function buildDxf(items, options) {
    const w = new Writer();
    const hasOpt = !!options;
    const textH = hasOpt ? numOr(options.textHeight, LABEL_HEIGHT) : LABEL_HEIGHT;
    const photoSize = hasOpt ? numOr(options.photoSize, 10) : 10;
    const textGap = hasOpt ? numOr(options.textGap, 5) : 5;
    const pointSize = hasOpt ? numOr(options.pointSize, 0) : 0;
    const legacyOff = Math.max(LABEL_OFFSET, pointSize / 2);
    const pointGap = hasOpt && typeof options.pointGap === 'number' && isFinite(options.pointGap) && options.pointGap >= 0 ? options.pointGap : 2; // 점-사진 간격 (0 허용)
    const showName = !(hasOpt && options.showName === false); // 파일명 표시 OFF이면 TEXT를 만들지 않음
    const hasImages = hasOpt && items.some(function (it) { return !!it.image; });

    // ----- 핸들 미리 배정 -----
    const h = {
      ltypeTable: w.next(), ltByBlock: w.next(), ltByLayer: w.next(), ltCont: w.next(),
      layerTable: w.next(), layer0: w.next(), layerPoint: w.next(), layerLabel: w.next(), layerImage: w.next(),
      styleTable: w.next(), styleStd: w.next(),
      appidTable: w.next(), appidAcad: w.next(),
      brTable: w.next(), brModel: w.next(), brPaper: w.next(),
      blkModel: w.next(), endModel: w.next(), blkPaper: w.next(), endPaper: w.next(),
      rootDict: '0C'
    };

    // ----- ENTITIES (핸들 소비) -----
    const ent = new Writer();
    ent.handle = w.handle;
    let pointCount = 0, textCount = 0;
    const images = [];
    items.forEach(function (item) {
      const x = item.dxf.x, y = item.dxf.y; // X = Easting, Y = Northing
      let textX = x + legacyOff, textY = y + legacyOff;

      if (hasImages && item.image) {
        const pw = item.image.width, ph = item.image.height;
        const scale = photoSize / Math.max(pw, ph);      // 긴 변 = 설정값, 픽셀은 정사각형 → 비율 유지
        const imgH = ph * scale;
        const img = { path: item.image.path, pw: pw, ph: ph, h: ent.next(), def: ent.next(), reactor: ent.next() };
        img.name = img.path.replace(/^.*\//, '').replace(/\.[^.]*$/, '');
        images.push(img);
        ent.add(0, 'IMAGE'); ent.add(5, img.h); ent.add(330, h.brModel);
        ent.add(100, 'AcDbEntity'); ent.add(8, 'PHOTO_IMAGE');
        ent.add(100, 'AcDbRasterImage'); ent.add(90, 0);
        const ix = x + pointGap;                                  // 사진 왼쪽 가장자리: POINT에서 오른쪽(+X, 동쪽)으로 간격만큼
        const iy = y - imgH / 2;                                  // 사진 세로 중앙이 POINT의 Y(북쪽)와 같도록
        ent.num(10, ix); ent.num(20, iy); ent.num(30, 0);        // 삽입점 = 이미지 왼쪽 아래 모서리 (POINT 자체는 이동하지 않음)
        ent.add(11, scale.toFixed(10)); ent.add(21, '0.0000000000'); ent.add(31, '0.0000000000'); // U: 픽셀 한 칸의 가로 방향(m)
        ent.add(12, '0.0000000000'); ent.add(22, scale.toFixed(10)); ent.add(32, '0.0000000000'); // V: 픽셀 한 칸의 세로 방향(m)
        ent.add(13, pw); ent.add(23, ph);                         // 이미지 크기(픽셀)
        ent.add(340, img.def);
        ent.add(70, 3); ent.add(280, 0); ent.add(281, 50); ent.add(282, 50); ent.add(283, 0);
        ent.add(360, img.reactor);
        ent.add(71, 1); ent.add(91, 2);                           // 사각형 클립 경계(전체)
        ent.add(14, '-0.5'); ent.add(24, '-0.5');
        ent.add(14, (pw - 0.5).toFixed(1)); ent.add(24, (ph - 0.5).toFixed(1));
        textX = ix; textY = iy + imgH + textGap;                  // 사진 윗변 위에 글자 (사진 왼쪽 가장자리에 맞춤)
      }

      ent.add(0, 'POINT'); ent.add(5, ent.next()); ent.add(330, h.brModel);
      ent.add(100, 'AcDbEntity'); ent.add(8, 'PHOTO_POINT');
      ent.add(100, 'AcDbPoint'); ent.num(10, x); ent.num(20, y); ent.num(30, 0);
      pointCount += 1;

      if (showName) {
        ent.add(0, 'TEXT'); ent.add(5, ent.next()); ent.add(330, h.brModel);
        ent.add(100, 'AcDbEntity'); ent.add(8, 'PHOTO_LABEL');
        ent.add(100, 'AcDbText'); ent.num(10, textX); ent.num(20, textY); ent.num(30, 0);
        // 사용자 지정 이름(item.label)이 있으면 그것을, 없으면 원본 파일명을 CAD 글자로 사용
        ent.num(40, textH); ent.add(1, cleanText(item.label ? item.label : item.fileName)); ent.num(50, 0);
        ent.add(7, 'Standard');
        // AutoCAD DXF 규격: TEXT는 AcDbText 구분자가 두 번 나오며, 두 번째 뒤에는 수직 정렬(73)이 온다
        ent.add(100, 'AcDbText'); ent.add(73, 0);
        textCount += 1;
      }
    });
    const imageDict = images.length ? ent.next() : null;
    const handseed = (ent.handle + 1).toString(16).toUpperCase();

    // ----- HEADER -----
    w.add(0, 'SECTION'); w.add(2, 'HEADER');
    w.add(9, '$ACADVER'); w.add(1, 'AC1021');
    w.add(9, '$HANDSEED'); w.add(5, handseed);
    w.add(9, '$MEASUREMENT'); w.add(70, 1);
    w.add(9, '$INSUNITS'); w.add(70, 6); // 6 = 미터
    if (pointSize > 0) { w.add(9, '$PDMODE'); w.add(70, 34); w.add(9, '$PDSIZE'); w.add(40, pointSize); } // POINT를 ⊗ 모양, 설정 크기로 표시
    w.add(0, 'ENDSEC');

    // ----- CLASSES -----
    w.add(0, 'SECTION'); w.add(2, 'CLASSES');
    if (images.length) {
      [['IMAGE', 'AcDbRasterImage', 127, 1], ['IMAGEDEF', 'AcDbRasterImageDef', 0, 0], ['IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', 1, 0]].forEach(function (c) {
        w.add(0, 'CLASS'); w.add(1, c[0]); w.add(2, c[1]); w.add(3, 'ISM'); w.add(90, c[2]); w.add(91, images.length); w.add(280, 0); w.add(281, c[3]);
      });
    }
    w.add(0, 'ENDSEC');

    // ----- TABLES -----
    w.add(0, 'SECTION'); w.add(2, 'TABLES');

    function tableStart(name, handle, count) {
      w.add(0, 'TABLE'); w.add(2, name); w.add(5, handle); w.add(330, 0);
      w.add(100, 'AcDbSymbolTable'); w.add(70, count);
    }
    function recordStart(type, handle, owner, sub) {
      w.add(0, type); w.add(5, handle); w.add(330, owner);
      w.add(100, 'AcDbSymbolTableRecord'); w.add(100, sub);
    }

    tableStart('LTYPE', h.ltypeTable, 3);
    recordStart('LTYPE', h.ltByBlock, h.ltypeTable, 'AcDbLinetypeTableRecord');
    w.add(2, 'ByBlock'); w.add(70, 0); w.add(3, ''); w.add(72, 65); w.add(73, 0); w.add(40, 0.0);
    recordStart('LTYPE', h.ltByLayer, h.ltypeTable, 'AcDbLinetypeTableRecord');
    w.add(2, 'ByLayer'); w.add(70, 0); w.add(3, ''); w.add(72, 65); w.add(73, 0); w.add(40, 0.0);
    recordStart('LTYPE', h.ltCont, h.ltypeTable, 'AcDbLinetypeTableRecord');
    w.add(2, 'Continuous'); w.add(70, 0); w.add(3, 'Solid line'); w.add(72, 65); w.add(73, 0); w.add(40, 0.0);
    w.add(0, 'ENDTAB');

    const layers = [['0', h.layer0], ['PHOTO_POINT', h.layerPoint], ['PHOTO_LABEL', h.layerLabel]];
    if (images.length) layers.push(['PHOTO_IMAGE', h.layerImage]);
    tableStart('LAYER', h.layerTable, layers.length);
    layers.forEach(function (l) {
      recordStart('LAYER', l[1], h.layerTable, 'AcDbLayerTableRecord');
      w.add(2, l[0]); w.add(70, 0); w.add(62, 7); w.add(6, 'Continuous');
    });
    w.add(0, 'ENDTAB');

    tableStart('STYLE', h.styleTable, 1);
    recordStart('STYLE', h.styleStd, h.styleTable, 'AcDbTextStyleTableRecord');
    w.add(2, 'Standard'); w.add(70, 0); w.add(40, 0.0); w.add(41, 1.0); w.add(50, 0.0);
    w.add(71, 0); w.add(42, 2.5); w.add(3, 'malgun.ttf'); w.add(4, ''); // 한글 표시용 글꼴(맑은 고딕)
    w.add(0, 'ENDTAB');

    tableStart('APPID', h.appidTable, 1);
    recordStart('APPID', h.appidAcad, h.appidTable, 'AcDbRegAppTableRecord');
    w.add(2, 'ACAD'); w.add(70, 0);
    w.add(0, 'ENDTAB');

    tableStart('BLOCK_RECORD', h.brTable, 2);
    recordStart('BLOCK_RECORD', h.brModel, h.brTable, 'AcDbBlockTableRecord');
    w.add(2, '*Model_Space');
    recordStart('BLOCK_RECORD', h.brPaper, h.brTable, 'AcDbBlockTableRecord');
    w.add(2, '*Paper_Space');
    w.add(0, 'ENDTAB');

    w.add(0, 'ENDSEC');

    // ----- BLOCKS -----
    w.add(0, 'SECTION'); w.add(2, 'BLOCKS');
    [['*Model_Space', h.blkModel, h.endModel, h.brModel], ['*Paper_Space', h.blkPaper, h.endPaper, h.brPaper]].forEach(function (b) {
      w.add(0, 'BLOCK'); w.add(5, b[1]); w.add(330, b[3]);
      w.add(100, 'AcDbEntity'); w.add(8, '0'); w.add(100, 'AcDbBlockBegin');
      w.add(2, b[0]); w.add(70, 0); w.num(10, 0); w.num(20, 0); w.num(30, 0); w.add(3, b[0]); w.add(1, '');
      w.add(0, 'ENDBLK'); w.add(5, b[2]); w.add(330, b[3]);
      w.add(100, 'AcDbEntity'); w.add(8, '0'); w.add(100, 'AcDbBlockEnd');
    });
    w.add(0, 'ENDSEC');

    // ----- ENTITIES -----
    w.add(0, 'SECTION'); w.add(2, 'ENTITIES');
    Array.prototype.push.apply(w.lines, ent.lines);
    w.add(0, 'ENDSEC');

    // ----- OBJECTS (루트 사전 + 이미지 사전/IMAGEDEF/IMAGEDEF_REACTOR) -----
    w.add(0, 'SECTION'); w.add(2, 'OBJECTS');
    w.add(0, 'DICTIONARY'); w.add(5, h.rootDict); w.add(330, 0);
    w.add(100, 'AcDbDictionary'); w.add(281, 1);
    if (images.length) { w.add(3, 'ACAD_IMAGE_DICT'); w.add(350, imageDict); }
    if (images.length) {
      w.add(0, 'DICTIONARY'); w.add(5, imageDict);
      w.add(102, '{ACAD_REACTORS'); w.add(330, h.rootDict); w.add(102, '}');
      w.add(330, h.rootDict); w.add(100, 'AcDbDictionary'); w.add(281, 1);
      images.forEach(function (im) { w.add(3, im.name); w.add(350, im.def); });
      images.forEach(function (im) {
        w.add(0, 'IMAGEDEF'); w.add(5, im.def);
        w.add(102, '{ACAD_REACTORS'); w.add(330, imageDict); w.add(330, im.reactor); w.add(102, '}');
        w.add(330, imageDict); w.add(100, 'AcDbRasterImageDef'); w.add(90, 0);
        w.add(1, im.path);                                  // 상대 경로 (예: thumbnails/photo_001.jpg)
        w.add(10, im.pw); w.add(20, im.ph);
        w.add(11, '1.0'); w.add(21, '1.0');
        w.add(280, 1); w.add(281, 0);
        w.add(0, 'IMAGEDEF_REACTOR'); w.add(5, im.reactor); w.add(330, im.h);
        w.add(100, 'AcDbRasterImageDefReactor'); w.add(90, 2); w.add(330, im.h);
      });
    }
    w.add(0, 'ENDSEC');

    w.add(0, 'EOF');
    return { text: w.lines.join('\r\n') + '\r\n', points: pointCount, texts: textCount, images: images.length };
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fileName() {
    const d = new Date();
    return 'photo-coordinates-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.dxf';
  }
  
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000); // 큰 ZIP 다운로드가 끝나기 전에 해제되지 않도록 넉넉히
  }

  function pad3(n) { return String(n).padStart(3, '0'); }

  // ZIP 안에 쓸 수 있는 파일 이름으로 정리 (경로 구분자·금지 문자 제거, 한글은 유지)
  function safeFileName(name) {
    let t = String(name || 'photo').replace(/[\u0000-\u001F\u007F\\/:*?"<>|]+/g, '_').replace(/^\.+/, '_').trim();
    if (!t) t = 'photo';
    if (t.length > 120) {
      const dot = t.lastIndexOf('.');
      const ext = dot > 0 && t.length - dot <= 10 ? t.slice(dot) : '';
      t = t.slice(0, 120 - ext.length) + ext;
    }
    return t;
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hrefOf(path) { return path.split('/').map(encodeURIComponent).join('/'); }

  // photo-index.html: 스크립트 없는 정적 목록. 썸네일과 원본 사진을 ZIP 안의 상대 경로로 연결
  function buildIndexHtml(rows, epsgText) {
    const body = rows.map(function (r) {
      const img = r.thumb ? '<img src="' + hrefOf(r.thumb) + '" alt="' + esc(r.name) + '">' : '';
      const thumb = r.thumb ? (r.original ? '<a href="' + hrefOf(r.original) + '">' + img + '</a>' : img) : '<span class="none">썸네일 없음</span>';
      const orig = r.original ? '<a href="' + hrefOf(r.original) + '">' + esc(r.name) + '</a>' : esc(r.name);
      return '<tr><td>' + r.no + '</td><td class="th">' + thumb + '</td><td>' + orig + '<br><small>' + esc(r.original || '') + '</small></td><td>' + esc(r.dateTime || '-') +
        '</td><td class="n">' + esc(r.lat) + '</td><td class="n">' + esc(r.lon) + '</td><td class="n">' + esc(r.easting) + '</td><td class="n">' + esc(r.northing) + '</td></tr>';
    }).join('\n');
    return '<!DOCTYPE html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n<title>사진 목록</title>\n' +
      '<style>body{font-family:"Malgun Gothic",sans-serif;margin:16px;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:middle;font-size:14px}' +
      'th{background:#f1f3f5}td.n{text-align:right;font-variant-numeric:tabular-nums}td.th img{max-width:160px;max-height:120px;display:block}small{color:#777;word-break:break-all}.none{color:#999}.wrap{overflow-x:auto}</style></head><body>\n' +
      '<h1>사진 목록 (' + rows.length + '장)</h1>\n<p>좌표계: ' + esc(epsgText) + ' · DXF 좌표: X = 동쪽(Easting), Y = 북쪽(Northing) · 이름이나 썸네일을 누르면 원본 사진이 열립니다.</p>\n' +
      '<div class="wrap"><table><thead><tr><th>No</th><th>썸네일</th><th>원본 사진</th><th>촬영 일시</th><th>위도</th><th>경도</th><th>동쪽 E (DXF X)</th><th>북쪽 N (DXF Y)</th></tr></thead>\n<tbody>\n' + body + '\n</tbody></table></div></body></html>\n';
  }

  async function waitForThumbnails(files, indexes) {
    const T = window.PhotoThumbnails;
    if (!T) return;
    const waiting = indexes.filter(function (i) {
      const st = T.getStatus(files[i]);
      return st === 'PENDING' || st === 'PROCESSING';
    });
    if (waiting.length === 0) return;
    showNote('썸네일 준비를 기다리는 중입니다...');
    await Promise.race([
      Promise.all(waiting.map(function (i) { return T.generate(files[i]); })), // 이미 대기 중인 생성이 끝나기를 기다릴 뿐, 새로 만들지 않음
      new Promise(function (resolve) { setTimeout(resolve, 30000); })
    ]);
  }

  let busy = false;
  const customNames = new WeakMap(); // File 객체 → 사용자 지정 CAD 표시 이름 (같은 이름의 사진도 File이 달라 따로 관리됨)

  async function exportDxf(settings) {
    if (busy) return;
    if (!window.photoResults) { showNote('결과 데이터를 불러오지 못했습니다.'); return; }
    let results;
    try {
      results = window.photoResults.getResults();
    } catch (error) {
      showNote('결과 데이터를 읽는 중 오류가 발생했습니다.');
      return;
    }
    if (results.length === 0) { showNote('내보낼 사진이 없습니다. 사진을 먼저 업로드하세요.'); return; }

    const validIdx = [];
    results.forEach(function (r, i) { if (isValidItem(r)) validIdx.push(i); });
    const skipped = results.length - validIdx.length;
    const pending = results.filter(function (r) { return r.status === 'PENDING'; }).length;
    if (validIdx.length === 0) {
      showNote(pending > 0
        ? '아직 처리 중이거나 변환된 좌표가 없어 DXF를 만들지 않았습니다. 처리가 끝난 뒤 다시 시도하세요.'
        : 'DXF로 내보낼 변환된 좌표가 없습니다. (GPS 없음 또는 오류 사진만 있음)');
      return;
    }

    busy = true;
    try {
      if (!settings) { // 설정 화면이 없는 경우: 기존 방식(DXF 한 파일)
        const dxf = buildDxf(validIdx.map(function (i) { return results[i]; }), null);
        download(new Blob([dxf.text], { type: 'application/dxf;charset=utf-8' }), fileName());
        showNote('DXF 저장: POINT ' + dxf.points + '개, TEXT ' + dxf.texts + '개를 만들었습니다.');
        return;
      }
      if (!window.ZipWriter) { showNote('ZIP 모듈(zip.js)을 불러오지 못했습니다.'); return; }

      // 사진 목록 순서와 결과 순서가 같은지 확인 (같지 않으면 이미지 연결을 하지 않음)
      const files = window.photoList ? window.photoList.getFiles() : [];
      const aligned = files.length === results.length && results.every(function (r, i) { return r.fileName === files[i].name; });
      if (aligned) await waitForThumbnails(files, validIdx);

      const T = window.PhotoThumbnails;
      const zipEntries = [];
      const items = [];
      const rows = [];
      let thumbFail = 0;
      let originalFail = 0;
      for (const i of validIdx) {
        const r = results[i];
        const item = Object.assign({}, r);
        if (aligned) { const custom = customNames.get(files[i]); if (custom) item.label = custom; } // CAD TEXT에만 적용
        const no = pad3(i + 1);
        const row = { no: i + 1, name: r.fileName, dateTime: r.dateTime, lat: r.latitude.toFixed(6), lon: r.longitude.toFixed(6),
          easting: r.easting.toFixed(3), northing: r.northing.toFixed(3), thumb: null, original: null };
        if (aligned) {
          // 읽을 수 없는 원본(삭제·이동·클라우드 미동기화 등) 한 장 때문에 전체 저장이 실패하지 않도록 미리 읽기 확인
          let readable = true;
          try { await files[i].slice(0, 1).arrayBuffer(); } catch (error) { readable = false; originalFail += 1; }
          if (readable) {
            row.original = 'originals/photo_' + no + '_' + safeFileName(r.fileName);
            zipEntries.push({ name: row.original, data: files[i] }); // 원본 그대로 (변환 없음)
          }
          // 목록 번호가 아니라 File 객체로 찾아, 내보내는 중 목록이 바뀌어도 다른 사진의 썸네일이 섞이지 않게 함
          const t = T ? T.get(files[i]) : null;
          if (t && t.status === 'OK' && t.blob && t.width > 0 && t.height > 0) {
            row.thumb = 'thumbnails/photo_' + no + '.jpg';
            zipEntries.push({ name: row.thumb, data: t.blob });
            item.image = { path: row.thumb, width: t.width, height: t.height };
          } else {
            thumbFail += 1;
          }
        }
        items.push(item);
        rows.push(row);
      }

      const dxf = buildDxf(items, settings);
      zipEntries.unshift({ name: 'photo-coordinates.dxf', data: new Blob([dxf.text], { type: 'application/dxf;charset=utf-8' }) }); // UTF-8, BOM 없음
      zipEntries.push({ name: 'photo-index.html', data: new Blob([buildIndexHtml(rows, results[validIdx[0]].epsg)], { type: 'text/html;charset=utf-8' }) });

      showNote('ZIP 파일을 만드는 중입니다...');
      const zip = await window.ZipWriter.create(zipEntries);
      download(zip, fileName().replace(/\.dxf$/, '.zip'));
      let msg = 'ZIP 저장: POINT ' + dxf.points + '개, TEXT ' + dxf.texts + '개' + (settings.showName === false ? '(파일명 표시 끔)' : '') + ', 사진 이미지 ' + dxf.images + '개. 압축을 먼저 풀고 DXF를 여세요.';
      if (!aligned) msg += ' (사진 목록과 결과 순서가 달라 이미지 연결을 하지 않았습니다)';
      if (originalFail > 0) msg += ' 원본을 읽을 수 없어 ZIP에서 제외 ' + originalFail + '장.';
      if (thumbFail > 0) msg += ' 썸네일이 없어 이미지 제외 ' + thumbFail + '장.';
      if (skipped > 0) msg += ' (GPS 없음·오류 등 제외 ' + skipped + '장' + (pending > 0 ? ', 처리 중 ' + pending + '장 포함' : '') + ')';
      showNote(msg);
    } catch (error) {
      showNote('저장 중 오류가 발생했습니다: ' + (error && error.message ? error.message : ''));
    } finally {
      busy = false;
    }
  }

  // ---- 설정 화면 (모달) ----
  const modal = document.getElementById('dxf-modal');
  const fields = modal ? Array.prototype.slice.call(modal.querySelectorAll('.size-field')) : [];
  let lastSettings = null;
  let lastFocus = null;

  function clampValue(field, raw) {
    const min = parseFloat(field.dataset.min), max = parseFloat(field.dataset.max);
    const v = parseFloat(raw);
    if (!isFinite(v)) return null;
    return Math.min(max, Math.max(min, v));
  }

  function setField(field, value) {
    field.querySelector('.size-num').value = String(value);
    field.querySelector('.size-range-input').value = String(value);
    field.querySelector('.size-num').classList.remove('is-invalid');
  }

  function bindField(field) {
    const num = field.querySelector('.size-num');
    const range = field.querySelector('.size-range-input');
    range.addEventListener('input', function () { setField(field, range.value); });
    num.addEventListener('input', function () { // 입력 중에는 범위 안의 값만 슬라이더에 반영
      const v = clampValue(field, num.value);
      const inRange = v !== null && String(v) === String(parseFloat(num.value));
      num.classList.toggle('is-invalid', !inRange);
      if (v !== null) range.value = String(v);
    });
    num.addEventListener('change', function () { // 입력이 끝나면 범위로 보정, 비었거나 숫자가 아니면 슬라이더 값 유지
      const v = clampValue(field, num.value);
      setField(field, v === null ? range.value : v);
    });
  }

  function resetSizes() {
    fields.forEach(function (f) { setField(f, f.dataset.default); });
  }

  // 현재 화면의 설정값 → 전달용 객체 (단위 m)
  function readSettings() {
    const s = {};
    fields.forEach(function (f) {
      const v = clampValue(f, f.querySelector('.size-num').value);
      s[f.dataset.key] = v === null ? parseFloat(f.dataset.default) : v;
    });
    const checked = modal.querySelector('input[name="dxf-method"]:checked');
    const sn = document.getElementById('dxf-showName');
    s.showName = sn ? sn.checked : true;
    s.method = checked ? checked.value : 'external'; // 현재 구현된 방식은 'external'(외부 사진 연결)뿐
    return s;
  }

  // 사진별 CAD 표시 이름 입력 목록 (내보낼 수 있는 사진만, 입력값은 File 객체에 연결해 저장)
  function renderNameList() {
    const list = document.getElementById('dxf-name-list');
    if (!list) return;
    list.textContent = '';
    const files = window.photoList ? window.photoList.getFiles() : [];
    let results = [];
    try { results = window.photoResults.getResults(); } catch (error) { /* 목록 없이 계속 */ }
    const aligned = files.length === results.length && results.every(function (r, i) { return r.fileName === files[i].name; });
    const on = document.getElementById('dxf-showName');
    let count = 0;
    if (aligned) {
      results.forEach(function (r, i) {
        if (!isValidItem(r)) return;
        const file = files[i];
        const li = document.createElement('li');
        li.className = 'name-row';
        const orig = document.createElement('span');
        orig.className = 'name-orig';
        orig.textContent = (i + 1) + '. ' + r.fileName;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'name-input';
        input.maxLength = 100;
        input.placeholder = '원본 파일명 사용';
        input.setAttribute('aria-label', (i + 1) + '번 사진 CAD 표시 이름');
        input.value = customNames.get(file) || '';
        input.disabled = !!on && !on.checked;
        input.addEventListener('input', function () {
          const v = input.value.trim();
          if (v) customNames.set(file, v); else customNames.delete(file);
        });
        li.appendChild(orig);
        li.appendChild(input);
        list.appendChild(li);
        count += 1;
      });
    }
    if (count === 0) {
      const li = document.createElement('li');
      li.className = 'name-empty';
      li.textContent = aligned ? '이름을 지정할 수 있는 사진(GPS가 있는 사진)이 없습니다.' : '사진 목록을 확인할 수 없어 이름을 지정할 수 없습니다.';
      list.appendChild(li);
    }
  }

  function syncNameState() {
    const on = document.getElementById('dxf-showName');
    const box = document.getElementById('dxf-name-box');
    if (!on || !box) return;
    box.classList.toggle('is-off', !on.checked);
    box.querySelectorAll('.name-input').forEach(function (el) { el.disabled = !on.checked; });
  }

  function openModal() {
    renderNameList();
    syncNameState();
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const first = modal.querySelector('.size-num');
    if (first) first.focus();
  }

  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function onSaveClick() {
    // 내보낼 사진이 아예 없으면 설정 화면을 열지 않고 기존 안내를 표시
    if (!window.photoResults || window.photoResults.getResults().length === 0) {
      showNote('내보낼 사진이 없습니다. 사진을 먼저 업로드하세요.');
      return;
    }
    openModal();
  }

  function onExportClick() {
    lastSettings = readSettings();
    closeModal();
    exportDxf(lastSettings);
  }

  btn.disabled = false;
  if (!modal) {
    btn.addEventListener('click', function () { exportDxf(null); }); // 설정 화면이 없으면 기존 방식으로 동작
  } else {
    fields.forEach(bindField);
    const showNameBox = document.getElementById('dxf-showName');
    if (showNameBox) showNameBox.addEventListener('change', syncNameState);
    btn.addEventListener('click', onSaveClick);
    document.getElementById('dxf-export').addEventListener('click', onExportClick);
    document.getElementById('dxf-reset').addEventListener('click', function () {
      resetSizes(); // 네 가지 크기와 파일명 표시(ON)를 기본값으로 (내보내기 방식·사진별 이름은 유지)
      if (showNameBox) { showNameBox.checked = true; syncNameState(); }
    });
    modal.querySelectorAll('[data-modal-close]').forEach(function (el) { el.addEventListener('click', closeModal); });
    modal.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
      if (event.key !== 'Tab') return; // 모달 안에서만 Tab 이동
      const focusable = Array.prototype.slice.call(modal.querySelectorAll('button, input')).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
      if (focusable.length === 0) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  // 마지막으로 전달된 설정을 읽을 수 있도록 제공
  window.DxfExport = {
    getLastSettings: function () { return lastSettings ? Object.assign({}, lastSettings) : null; },
    _buildDxf: buildDxf // 점검용
  };
})();