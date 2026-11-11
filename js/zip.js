/* ===== ZIP 만들기 (외부 라이브러리 없음) =====
 * 브라우저 안에서 ZIP 파일을 만듭니다. 압축하지 않고 그대로 담는 방식(STORE)이라
 * 이미 압축된 JPEG에 적합하고, 구현이 단순하며 외부 CDN이 필요 없습니다.
 * - 파일 이름은 UTF-8(한글 가능)로 저장합니다.
 * - 사진 같은 큰 파일은 CRC 계산을 위해 조각(8MB)씩만 읽고, ZIP 안에는 File 객체를 그대로 참조하므로 메모리를 적게 씁니다.
 * - ZIP64는 지원하지 않습니다(전체 4GB 미만, 파일 65,535개 미만).
 *
 * 사용: ZipWriter.create([{ name: 'a/b.jpg', data: Blob | File | string | Uint8Array }, ...]) → Promise<Blob>
 */
(function () {
  'use strict';

  const CHUNK = 8 * 1024 * 1024;
  const LIMIT = 0xFFFFFFFF;

  const table = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crcUpdate(crc, bytes) {
    for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return crc;
  }

  function crc32(bytes) { return (crcUpdate(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0; }

  function toBlob(data) {
    if (data instanceof Blob) return data;
    if (typeof data === 'string') return new Blob([data], { type: 'text/plain;charset=utf-8' });
    return new Blob([data]);
  }

  async function crcOfBlob(blob) {
    let crc = 0xFFFFFFFF;
    for (let pos = 0; pos < blob.size; pos += CHUNK) {
      const buf = await blob.slice(pos, Math.min(blob.size, pos + CHUNK)).arrayBuffer();
      crc = crcUpdate(crc, new Uint8Array(buf));
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xFFFF, date: day & 0xFFFF };
  }

  async function create(entries) {
    if (!Array.isArray(entries)) throw new Error('ZIP 항목 목록이 필요합니다');
    if (entries.length >= 0xFFFF) throw new Error('파일이 너무 많아 ZIP으로 만들 수 없습니다 (65,535개 미만)');
    const encoder = new TextEncoder();
    const stamp = dosDateTime(new Date());
    const seen = new Set();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = String(entry.name);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) throw new Error('ZIP 안의 파일 이름이 비었거나 중복됩니다: ' + name);
      seen.add(key);

      const blob = toBlob(entry.data);
      if (blob.size >= LIMIT) throw new Error('파일이 너무 커서 ZIP으로 만들 수 없습니다 (4GB 미만): ' + name);
      const nameBytes = encoder.encode(name);
      const crc = await crcOfBlob(blob);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // 필요한 버전
      local.setUint16(6, 0x0800, true);    // UTF-8 파일 이름
      local.setUint16(8, 0, true);         // STORE (압축 없음)
      local.setUint16(10, stamp.time, true);
      local.setUint16(12, stamp.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, blob.size, true);
      local.setUint32(22, blob.size, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, blob);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, stamp.time, true);
      cd.setUint16(14, stamp.date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, blob.size, true);
      cd.setUint32(24, blob.size, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + blob.size;
      if (offset >= LIMIT) throw new Error('전체 크기가 너무 커서 ZIP으로 만들 수 없습니다 (4GB 미만)');
    }

    let cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    if (offset + cdSize >= LIMIT) throw new Error('전체 크기가 너무 커서 ZIP으로 만들 수 없습니다 (4GB 미만)');

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  window.ZipWriter = { create: create, crc32: crc32 };
})();