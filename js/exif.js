/* ===== 사진 EXIF 추출 (3단계) =====
 * 추출 항목: 파일명, GPS 위도/경도(십진수), 촬영 일시(DateTimeOriginal)
 * 외부 라이브러리를 사용하지 않는 순수 JavaScript 구현입니다.
 * 사진은 브라우저 안에서 File.slice()/arrayBuffer()로만 읽으며 어디로도 전송하지 않습니다.
 *
 * 지원 형식: JPEG, HEIC/HEIF, PNG(eXIf 청크), WebP(EXIF 청크)
 * 사용법:   const meta = await window.ExifReader.readPhotoMeta(file);
 *           meta = { fileName, latitude, longitude, dateTime, status, message }
 *           status: 'OK' | 'NO_GPS' | 'ERROR'
 */
(function () {
  'use strict';

  const JPEG_HEAD_BYTES = 1024 * 1024; // JPEG는 앞부분 1MB만 먼저 읽음 (EXIF는 파일 앞쪽에 있음)

  // TIFF 값 형식별 바이트 크기
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  // 태그 번호
  const TAG_EXIF_IFD = 0x8769;
  const TAG_GPS_IFD = 0x8825;
  const TAG_DATETIME_ORIGINAL = 0x9003;
  const TAG_DATETIME_DIGITIZED = 0x9004;
  const TAG_GPS_LAT_REF = 0x0001;
  const TAG_GPS_LAT = 0x0002;
  const TAG_GPS_LON_REF = 0x0003;
  const TAG_GPS_LON = 0x0004;

  // ---------------------------------------------------------------
  // 공통 유틸
  // ---------------------------------------------------------------
  function asciiAt(view, pos, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(pos + i));
    return s;
  }

  // ---------------------------------------------------------------
  // 형식별 EXIF(TIFF) 위치 찾기 → { buffer, offset, length } 또는 null
  // ---------------------------------------------------------------

  // --- JPEG: APP1 세그먼트의 "Exif\0\0" 뒤가 TIFF 데이터 ---
  function findJpegExif(buf) {
    const v = new DataView(buf);
    const len = v.byteLength;
    let pos = 2; // SOI(FFD8) 다음

    while (pos + 4 <= len) {
      if (v.getUint8(pos) !== 0xFF) return { truncated: false };
      const marker = v.getUint8(pos + 1);

      if (marker === 0xFF) { pos += 1; continue; }                 // 패딩
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        pos += 2; continue;                                        // 길이 없는 마커
      }
      if (marker === 0xDA || marker === 0xD9) return { truncated: false }; // 이미지 데이터 시작/끝

      const segLen = v.getUint16(pos + 2, false);
      if (segLen < 2) return { truncated: false };
      const dataStart = pos + 4;
      const dataEnd = pos + 2 + segLen;
      if (dataEnd > len) return { truncated: true }; // 읽어 둔 범위를 벗어남

      if (marker === 0xE1 && dataEnd - dataStart >= 14 &&
          asciiAt(v, dataStart, 4) === 'Exif' &&
          v.getUint8(dataStart + 4) === 0 && v.getUint8(dataStart + 5) === 0) {
        return { found: { buffer: buf, offset: dataStart + 6, length: dataEnd - (dataStart + 6) } };
      }
      pos = dataEnd;
    }
    return { truncated: true };
  }

  async function locateJpegExif(file) {
    let size = Math.min(file.size, JPEG_HEAD_BYTES);
    for (;;) {
      const buf = await file.slice(0, size).arrayBuffer();
      const r = findJpegExif(buf);
      if (r.found) return r.found;
      if (!r.truncated || size >= file.size) return null;
      size = file.size; // 앞부분에서 못 찾았고 잘렸다면 전체를 읽어 다시 시도
    }
  }

  // --- PNG: 'eXIf' 청크 데이터가 곧 TIFF ---
  function findPngExif(buf) {
    const v = new DataView(buf);
    const len = v.byteLength;
    let pos = 8; // 시그니처 다음
    while (pos + 12 <= len) {
      const size = v.getUint32(pos, false);
      const type = asciiAt(v, pos + 4, 4);
      if (type === 'eXIf') {
        if (pos + 8 + size > len) return null;
        return { buffer: buf, offset: pos + 8, length: size };
      }
      if (type === 'IEND') break;
      pos += 12 + size;
    }
    return null;
  }

  // --- WebP: 'EXIF' 청크 (앞에 "Exif\0\0"가 붙은 경우도 처리) ---
  function findWebpExif(buf) {
    const v = new DataView(buf);
    const len = v.byteLength;
    let pos = 12; // 'RIFF' size 'WEBP' 다음
    while (pos + 8 <= len) {
      const type = asciiAt(v, pos, 4);
      const size = v.getUint32(pos + 4, true);
      const dataStart = pos + 8;
      if (type === 'EXIF') {
        if (dataStart + size > len) return null;
        let offset = dataStart;
        let length = size;
        if (length >= 6 && asciiAt(v, offset, 4) === 'Exif') { offset += 6; length -= 6; }
        return { buffer: buf, offset: offset, length: length };
      }
      pos = dataStart + size + (size & 1); // 청크는 짝수 바이트로 맞춰짐
    }
    return null;
  }

  // --- HEIC/HEIF: ISO BMFF 박스 구조에서 'Exif' 항목의 위치를 찾음 ---
  function readUint(v, pos, size) {
    if (size === 0) return 0;
    if (size === 1) return v.getUint8(pos);
    if (size === 2) return v.getUint16(pos, false);
    if (size === 4) return v.getUint32(pos, false);
    if (size === 8) return v.getUint32(pos, false) * 4294967296 + v.getUint32(pos + 4, false);
    throw new Error('지원하지 않는 HEIC 필드 크기');
  }

  function readBoxes(v, start, end) {
    const boxes = [];
    let pos = start;
    while (pos + 8 <= end) {
      let size = v.getUint32(pos, false);
      const type = asciiAt(v, pos + 4, 4);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        size = readUint(v, pos + 8, 8);
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header || pos + size > end) break;
      boxes.push({ type: type, start: pos + header, end: pos + size });
      pos += size;
    }
    return boxes;
  }

  function findExifItemId(v, iinf) {
    const s = iinf.start;
    const version = v.getUint8(s);
    let pos;
    if (version === 0) { pos = s + 6; } else { pos = s + 8; } // version/flags(4) + entry_count(2 또는 4)
    const entries = readBoxes(v, pos, iinf.end);
    for (let i = 0; i < entries.length; i++) {
      const box = entries[i];
      if (box.type !== 'infe') continue;
      const t = box.start;
      const ver = v.getUint8(t);
      if (ver < 2) continue; // item_type은 version 2 이상에만 있음
      let id, typePos;
      if (ver === 2) { id = v.getUint16(t + 4, false); typePos = t + 8; }
      else { id = v.getUint32(t + 4, false); typePos = t + 10; }
      if (typePos + 4 <= box.end && asciiAt(v, typePos, 4) === 'Exif') return id;
    }
    return null;
  }

  function findItemLocation(v, iloc, targetId) {
    const s = iloc.start;
    const version = v.getUint8(s);
    const sizes1 = v.getUint8(s + 4);
    const sizes2 = v.getUint8(s + 5);
    const offsetSize = sizes1 >> 4;
    const lengthSize = sizes1 & 0x0F;
    const baseOffsetSize = sizes2 >> 4;
    const indexSize = version === 1 || version === 2 ? (sizes2 & 0x0F) : 0;

    let pos = s + 6;
    let itemCount;
    if (version < 2) { itemCount = v.getUint16(pos, false); pos += 2; }
    else { itemCount = v.getUint32(pos, false); pos += 4; }

    for (let i = 0; i < itemCount; i++) {
      let id;
      if (version < 2) { id = v.getUint16(pos, false); pos += 2; }
      else { id = v.getUint32(pos, false); pos += 4; }

      let constructionMethod = 0;
      if (version === 1 || version === 2) {
        constructionMethod = v.getUint16(pos, false) & 0x000F;
        pos += 2;
      }
      pos += 2; // data_reference_index
      const baseOffset = readUint(v, pos, baseOffsetSize); pos += baseOffsetSize;
      const extentCount = v.getUint16(pos, false); pos += 2;

      const extents = [];
      for (let e = 0; e < extentCount; e++) {
        if (indexSize > 0) pos += indexSize;
        const off = readUint(v, pos, offsetSize); pos += offsetSize;
        const len = readUint(v, pos, lengthSize); pos += lengthSize;
        extents.push({ offset: off, length: len });
      }
      if (id === targetId) {
        return { constructionMethod: constructionMethod, baseOffset: baseOffset, extents: extents };
      }
    }
    return null;
  }

  function findHeifExif(buf) {
    const v = new DataView(buf);
    const top = readBoxes(v, 0, v.byteLength);
    const meta = top.find(function (b) { return b.type === 'meta'; });
    if (!meta) return null;

    const children = readBoxes(v, meta.start + 4, meta.end); // meta는 version/flags(4바이트)가 먼저 옴
    const iinf = children.find(function (b) { return b.type === 'iinf'; });
    const iloc = children.find(function (b) { return b.type === 'iloc'; });
    if (!iinf || !iloc) return null;

    const exifId = findExifItemId(v, iinf);
    if (exifId === null) return null;

    const loc = findItemLocation(v, iloc, exifId);
    if (!loc || loc.extents.length === 0) return null;
    if (loc.constructionMethod !== 0 || loc.extents.length !== 1) {
      throw new Error('지원하지 않는 HEIC 저장 구조입니다');
    }

    const itemStart = loc.baseOffset + loc.extents[0].offset;
    const itemLength = loc.extents[0].length;
    if (itemLength < 8 || itemStart + itemLength > v.byteLength) {
      throw new Error('HEIC EXIF 위치가 올바르지 않습니다');
    }
    // 항목 앞 4바이트 = TIFF 헤더까지의 거리
    const tiffStart = itemStart + 4 + v.getUint32(itemStart, false);
    const tiffLength = itemStart + itemLength - tiffStart;
    if (tiffLength < 8) throw new Error('HEIC EXIF 데이터가 비어 있습니다');
    return { buffer: buf, offset: tiffStart, length: tiffLength };
  }

  // --- 파일 앞부분으로 형식을 판별해 EXIF 위치를 찾음 ---
  async function locateExif(file) {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());

    if (head[0] === 0xFF && head[1] === 0xD8) {
      return locateJpegExif(file);
    }
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) {
      return findPngExif(await file.arrayBuffer());
    }
    const tag = String.fromCharCode(head[0], head[1], head[2], head[3]);
    const tag8 = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (tag === 'RIFF' && tag8 === 'WEBP') {
      return findWebpExif(await file.arrayBuffer());
    }
    if (String.fromCharCode(head[4], head[5], head[6], head[7]) === 'ftyp') {
      return findHeifExif(await file.arrayBuffer());
    }
    return null; // EXIF를 읽을 수 없는 형식
  }

  // ---------------------------------------------------------------
  // TIFF(EXIF) 파싱
  // ---------------------------------------------------------------
  function readIfd(view, ifdOffset, little) {
    const entries = new Map();
    let pos = ifdOffset;
    if (pos + 2 > view.byteLength) throw new Error('EXIF IFD 위치가 올바르지 않습니다');
    const count = view.getUint16(pos, little);
    pos += 2;
    for (let i = 0; i < count; i++, pos += 12) {
      if (pos + 12 > view.byteLength) break;
      const tag = view.getUint16(pos, little);
      const type = view.getUint16(pos + 2, little);
      const n = view.getUint32(pos + 4, little);
      const unit = TYPE_SIZE[type];
      if (!unit) continue;
      const total = unit * n;
      const dataPos = total <= 4 ? pos + 8 : view.getUint32(pos + 8, little);
      if (dataPos + total > view.byteLength) continue; // 범위를 벗어난 값은 무시
      entries.set(tag, { type: type, count: n, dataPos: dataPos });
    }
    return entries;
  }

  function readAscii(view, entry) {
    let s = '';
    for (let i = 0; i < entry.count; i++) {
      const c = view.getUint8(entry.dataPos + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  function readNumbers(view, entry, little) {
    const out = [];
    for (let i = 0; i < entry.count; i++) {
      const p = entry.dataPos + i * 8;
      if (entry.type === 5) {          // RATIONAL (부호 없음)
        const den = view.getUint32(p + 4, little);
        out.push(den === 0 ? NaN : view.getUint32(p, little) / den);
      } else if (entry.type === 10) {  // SRATIONAL (부호 있음)
        const den = view.getInt32(p + 4, little);
        out.push(den === 0 ? NaN : view.getInt32(p, little) / den);
      } else {
        return [];
      }
    }
    return out;
  }

  function readPointer(view, entry, little) {
    if (!entry) return null;
    if (entry.type === 4) return view.getUint32(entry.dataPos, little);
    if (entry.type === 3) return view.getUint16(entry.dataPos, little);
    return null;
  }

  // EXIF 날짜 "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DD HH:MM:SS" (잘못된 값은 빈 문자열)
  function formatExifDate(raw) {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw || '');
    if (!m) return '';
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    if (year === 0 || month < 1 || month > 12 || day < 1 || day > 31) return '';
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];
  }

  // 도·분·초(DMS) → 십진수 도(Decimal Degrees). 남위(S)·서경(W)은 음수
  function dmsToDecimal(parts, ref, positiveRef, negativeRef) {
    if (!parts || parts.length < 1 || parts.length > 3) return null;
    const d = parts[0];
    const m = parts.length > 1 ? parts[1] : 0;
    const s = parts.length > 2 ? parts[2] : 0;
    if (![d, m, s].every(Number.isFinite)) return null;
    const direction = (ref || '').charAt(0).toUpperCase();
    if (direction !== positiveRef && direction !== negativeRef) return null; // 방향을 알 수 없으면 사용하지 않음
    const value = d + m / 60 + s / 3600;
    return direction === negativeRef ? -value : value;
  }

  function extractGps(view, gpsEntries, little) {
    const latRefE = gpsEntries.get(TAG_GPS_LAT_REF);
    const latE = gpsEntries.get(TAG_GPS_LAT);
    const lonRefE = gpsEntries.get(TAG_GPS_LON_REF);
    const lonE = gpsEntries.get(TAG_GPS_LON);
    if (!latRefE || !latE || !lonRefE || !lonE) return null;

    const lat = dmsToDecimal(readNumbers(view, latE, little), readAscii(view, latRefE), 'N', 'S');
    const lon = dmsToDecimal(readNumbers(view, lonE, little), readAscii(view, lonRefE), 'E', 'W');
    if (lat === null || lon === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (lat === 0 && lon === 0) return null; // GPS 신호를 못 잡았을 때 기록되는 0,0 값은 위치 없음으로 처리
    return { latitude: lat, longitude: lon };
  }

  function parseExifTiff(located) {
    const view = new DataView(located.buffer, located.offset, located.length);
    if (view.byteLength < 8) throw new Error('EXIF 헤더가 너무 짧습니다');

    const order = view.getUint16(0, false);
    let little;
    if (order === 0x4949) little = true;
    else if (order === 0x4D4D) little = false;
    else throw new Error('EXIF 바이트 순서를 알 수 없습니다');
    if (view.getUint16(2, little) !== 42) throw new Error('EXIF 헤더가 올바르지 않습니다');

    const ifd0 = readIfd(view, view.getUint32(4, little), little);
    const result = { dateTime: '', gps: null };

    // 촬영 일시: 하위 IFD에 문제가 있어도 GPS 추출은 계속 진행
    try {
      const exifPtr = readPointer(view, ifd0.get(TAG_EXIF_IFD), little);
      if (exifPtr !== null) {
        const exifIfd = readIfd(view, exifPtr, little);
        const original = exifIfd.get(TAG_DATETIME_ORIGINAL);
        const digitized = exifIfd.get(TAG_DATETIME_DIGITIZED);
        result.dateTime = formatExifDate(original ? readAscii(view, original) : '') ||
                          formatExifDate(digitized ? readAscii(view, digitized) : '');
      }
    } catch (e) { /* 날짜만 비워 둠 */ }

    try {
      const gpsPtr = readPointer(view, ifd0.get(TAG_GPS_IFD), little);
      if (gpsPtr !== null) {
        result.gps = extractGps(view, readIfd(view, gpsPtr, little), little);
      }
    } catch (e) { /* GPS 없음으로 처리 */ }

    return result;
  }

  // ---------------------------------------------------------------
  // 공개 함수
  // ---------------------------------------------------------------
  async function readPhotoMeta(file) {
    const meta = {
      fileName: file.name,
      latitude: null,
      longitude: null,
      dateTime: '',
      status: 'NO_GPS',
      message: ''
    };
    try {
      const located = await locateExif(file);
      if (!located) return meta; // EXIF 없음 → NO_GPS

      const parsed = parseExifTiff(located);
      meta.dateTime = parsed.dateTime;
      if (parsed.gps) {
        meta.latitude = parsed.gps.latitude;
        meta.longitude = parsed.gps.longitude;
        meta.status = 'OK';
      }
    } catch (error) {
      meta.status = 'ERROR';
      meta.message = error && error.message ? error.message : '파일을 읽는 중 오류가 발생했습니다';
    }
    return meta;
  }

  window.ExifReader = { readPhotoMeta: readPhotoMeta };
})();