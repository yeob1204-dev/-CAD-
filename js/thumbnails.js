/* ===== 사진 썸네일 생성 (CAD 사진 연결용) =====
 * 업로드한 사진마다 가로세로 비율을 유지한 JPEG 썸네일(긴 변 최대 512px)을 만들어 브라우저 메모리에서 관리합니다.
 * - 원본 파일은 읽기만 하고 변경·저장·전송하지 않습니다.
 * - 썸네일은 File 객체 하나하나(사진 목록의 항목)를 키로 보관하므로, 같은 이름의 사진이 여러 장 있어도 서로 덮어쓰지 않습니다.
 * - 사진 목록에서 빠진 사진(목록 비우기 등)의 썸네일은 자동으로 정리됩니다.
 * - 한 장의 실패(HEIC 디코딩 불가, 손상 파일 등)는 그 사진의 상태에만 기록되며 EXIF·좌표 변환 흐름에 영향을 주지 않습니다.
 *
 * 공개 API: window.PhotoThumbnails
 *   generate(file)         → Promise<record>   특정 사진 썸네일 생성(이미 있으면 재사용)
 *   get(file)              → record | null     생성된 썸네일 정보 조회
 *   getStatus(file)        → 'NONE' | 'PENDING' | 'PROCESSING' | 'OK' | 'ERROR'
 *   getByIndex(i)          → record | null     사진 목록 i번째(= getResults()[i])의 썸네일
 *   getAll()               → [{ index, file, fileName, ...record }]   현재 사진 목록 순서대로
 *   clear()                → 모든 썸네일 메모리 정리
 *   MAX_SIZE, QUALITY      설정값
 * record: { status, blob, type, width, height, originalWidth, originalHeight, size, message }
 *   blob은 JPEG Blob입니다. 필요한 시점에 URL.createObjectURL(blob)로 쓰고 다 쓰면 revokeObjectURL 하세요.
 * 변경 알림: document 'thumbnailchange' 이벤트 (detail: { file, status })
 */
(function () {
  'use strict';

  const MAX_SIZE = 512;   // 긴 변 최대 px
  const QUALITY = 0.85;   // JPEG 품질

  const store = new Map(); // File → record (File 객체 단위라 같은 이름이어도 구분됨)
  const queue = [];        // 처리 대기 File 목록
  let running = false;

  function emit(file, status) {
    document.dispatchEvent(new CustomEvent('thumbnailchange', { detail: { file: file, status: status } }));
  }

  function blank(status, message) {
    return { status: status, blob: null, type: 'image/jpeg', width: 0, height: 0,
      originalWidth: 0, originalHeight: 0, size: 0, message: message || '' };
  }

  function isHeic(file) {
    return /\.(heic|heif)$/i.test(file.name || '') || /^image\/hei[cf]/i.test(file.type || '');
  }

  // ---- 디코딩: EXIF 회전을 반영해 비트맵(또는 img)으로 읽기 ----
  async function decode(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bmp, width: bmp.width, height: bmp.height, close: function () { if (bmp.close) bmp.close(); } };
      } catch (error) {
        // 옵션 미지원 또는 디코딩 실패 → 아래 <img> 방식으로 재시도
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise(function (resolve, reject) {
        const el = new Image();
        el.onload = function () { resolve(el); };
        el.onerror = function () { reject(new Error('decode')); };
        el.src = url;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: function () {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function toJpegBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob && blob.type === 'image/jpeg') resolve(blob);
        else reject(new Error('JPEG 인코딩을 지원하지 않습니다'));
      }, 'image/jpeg', QUALITY);
    });
  }

  async function makeThumbnail(file) {
    let decoded;
    try {
      decoded = await decode(file);
    } catch (error) {
      throw new Error(isHeic(file)
        ? '이 브라우저는 HEIC/HEIF 사진을 읽을 수 없어 썸네일을 만들지 못했습니다'
        : '이미지를 읽을 수 없어 썸네일을 만들지 못했습니다');
    }
    try {
      const ow = decoded.width, oh = decoded.height;
      if (!ow || !oh) throw new Error('이미지 크기를 확인할 수 없습니다');
      const scale = Math.min(1, MAX_SIZE / Math.max(ow, oh)); // 비율 유지, 확대하지 않음
      const w = Math.max(1, Math.round(ow * scale));
      const h = Math.max(1, Math.round(oh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('캔버스를 사용할 수 없습니다');
      ctx.fillStyle = '#ffffff'; // 투명 PNG/WebP는 흰 배경 (JPEG은 투명도 없음)
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(decoded.source, 0, 0, w, h);
      const blob = await toJpegBlob(canvas);
      canvas.width = canvas.height = 0; // 캔버스 메모리 해제
      return { status: 'OK', blob: blob, type: 'image/jpeg', width: w, height: h,
        originalWidth: ow, originalHeight: oh, size: blob.size, message: '' };
    } finally {
      decoded.close();
    }
  }

  // ---- 대기열: 메모리 사용을 줄이기 위해 한 번에 한 장씩 처리 ----
  function inList(file) {
    return !!window.photoList && window.photoList.getFiles().indexOf(file) !== -1;
  }

  async function runQueue() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const file = queue.shift();
        const current = store.get(file);
        if (!current || current.status !== 'PENDING') continue; // 이미 정리되었거나 처리됨
        current.status = 'PROCESSING';
        emit(file, 'PROCESSING');
        let result;
        try {
          result = await makeThumbnail(file);
        } catch (error) {
          result = blank('ERROR', error && error.message ? error.message : '썸네일 생성 오류');
        }
        if (store.get(file) !== current) continue; // 처리 중 목록에서 빠짐(목록 비우기 등) → 결과 버림
        store.set(file, Object.assign(current, result));
        emit(file, result.status);
      }
    } finally {
      running = false;
    }
  }

  function enqueue(file) {
    if (store.has(file)) return store.get(file);
    const rec = blank('PENDING');
    store.set(file, rec);
    queue.push(file);
    emit(file, 'PENDING');
    runQueue();
    return rec;
  }

  // 사진 목록에 있는 파일이 대상입니다(목록에서 빠지면 다음 목록 변경 때 정리됨).
  function generate(file) {
    return new Promise(function (resolve) {
      if (!(file instanceof Blob)) { resolve(blank('ERROR', '파일이 아닙니다')); return; }
      enqueue(file);
      const check = function () {
        const rec = store.get(file);
        if (!rec) { resolve(blank('ERROR', '목록에서 제거되었습니다')); return; }
        if (rec.status === 'OK' || rec.status === 'ERROR') { resolve(publicRecord(rec)); return; }
        setTimeout(check, 30);
      };
      check();
    });
  }

  function publicRecord(rec) { return Object.assign({}, rec); }

  // ---- 사진 목록과 동기화: 새 사진은 생성 대기열에, 빠진 사진은 메모리에서 제거 ----
  function sync() {
    const files = window.photoList ? window.photoList.getFiles() : [];
    const live = new Set(files);
    Array.from(store.keys()).forEach(function (file) {
      if (!live.has(file)) store.delete(file);
    });
    for (let i = queue.length - 1; i >= 0; i--) if (!live.has(queue[i])) queue.splice(i, 1);
    files.forEach(function (file) { if (!store.has(file)) enqueue(file); });
  }

  function clear() {
    store.clear();
    queue.length = 0;
  }

  document.addEventListener('photolistchange', function () {
    try { sync(); } catch (error) { /* 썸네일 문제가 다른 기능을 막지 않도록 */ }
  });

  window.PhotoThumbnails = {
    MAX_SIZE: MAX_SIZE,
    QUALITY: QUALITY,
    generate: generate,
    get: function (file) { const r = store.get(file); return r ? publicRecord(r) : null; },
    getStatus: function (file) { const r = store.get(file); return r ? r.status : 'NONE'; },
    getByIndex: function (index) {
      const files = window.photoList ? window.photoList.getFiles() : [];
      const r = files[index] ? store.get(files[index]) : null;
      return r ? publicRecord(r) : null;
    },
    getAll: function () {
      const files = window.photoList ? window.photoList.getFiles() : [];
      return files.map(function (file, index) {
        const r = store.get(file);
        return Object.assign({ index: index, file: file, fileName: file.name }, r ? publicRecord(r) : blank('NONE'));
      });
    },
    clear: clear,
    _size: function () { return store.size; } // 점검용: 메모리에 보관 중인 썸네일 수
  };

  sync();
})();