/* ===== EXIF 추출 결과 표시 (3단계) + 좌표 변환 연동 (4단계) =====
 * 사진 목록(window.photoList)이 바뀌면 새로 추가된 사진만 EXIF를 읽고,
 * 변환 결과 테이블에 파일명 / 촬영 일시 / 위도 / 경도 / X / Y / EPSG / 상태를 표시합니다.
 * 변환값은 js/projection.js의 CoordTransform이 easting(동)·northing(북)으로 돌려주며,
 * 화면·CSV 순서는 X=Northing(북), Y=Easting(동), DXF 순서는 X=Easting, Y=Northing 입니다.
 * 좌표계를 바꾸면 EXIF를 다시 읽지 않고 저장된 위·경도로 즉시 다시 계산합니다.
 * 사진은 브라우저 안에서만 처리되며 어디로도 전송되지 않습니다.
 */
(function () {
  'use strict';

  if (!window.photoList || !window.ExifReader) return;

  const tbody = document.querySelector('.result-table tbody');
  const badge = document.querySelector('.card-result .count-badge');
  const emptyRow = tbody ? tbody.querySelector('.empty-row') : null;
  if (!tbody || !badge || !emptyRow) return;

  const cache = new WeakMap(); // File → EXIF 추출 결과 (원본 보존, 변환 결과는 여기에 쓰지 않음)
  let working = false;
  let renderQueued = false;

  // ---- 표 그리기 ----
  function makeCell(text, label, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.setAttribute('data-label', label);
    td.textContent = text;
    return td;
  }

  function makeStatusCell(meta) {
    const td = document.createElement('td');
    td.setAttribute('data-label', '상태');
    if (!meta) {
      td.textContent = '처리 중';
      return td;
    }
    const span = document.createElement('span');
    span.className = 'status ' + (meta.status === 'OK' ? 'status-ok' : 'status-error');
    span.textContent = meta.status;
    if (meta.message) span.title = meta.message;
    td.appendChild(span);
    return td;
  }

  function formatDegree(value) {
    return typeof value === 'number' ? value.toFixed(6) : '-';
  }

  function formatMeter(value) {
    return typeof value === 'number' ? value.toFixed(3) : '-'; // 표시만 3자리, 계산값은 반올림하지 않음
  }

  function selectedEpsg() {
    const checked = document.querySelector('input[name="epsg"]:checked');
    return checked ? checked.value : '5179';
  }

  // EXIF 결과(meta) + 선택한 좌표계 → 행에 표시할 최종 값. 사진마다 독립적으로 처리(한 장의 실패가 전체를 멈추지 않음)
  function resolve(meta, epsg) {
    const out = { easting: null, northing: null, epsg: '', status: 'PENDING', message: '' };
    if (!meta) return out;
    out.status = meta.status;
    out.message = meta.message || '';
    if (meta.status !== 'OK') return out; // NO_GPS, ERROR: 변환 대상에서 제외
    out.epsg = 'EPSG:' + epsg;
    try {
      if (!window.CoordTransform) throw new Error('변환 모듈(projection.js)을 불러오지 못했습니다');
      const r = window.CoordTransform.transform(meta.longitude, meta.latitude, epsg); // 경도, 위도 순서
      out.easting = r.easting;
      out.northing = r.northing;
    } catch (error) {
      out.status = 'CONVERT_ERROR';
      out.message = error && error.message ? error.message : '좌표 변환 오류';
    }
    return out;
  }

  function buildRow(no, file, meta) {
    const res = resolve(meta, selectedEpsg());
    const tr = document.createElement('tr');
    tr.appendChild(makeCell(String(no), 'No', 'col-no'));
    tr.appendChild(makeCell(file.name, '파일명'));
    tr.appendChild(makeCell(meta && meta.dateTime ? meta.dateTime : '-', '촬영 일시'));
    tr.appendChild(makeCell(meta ? formatDegree(meta.latitude) : '-', '위도', 'num'));
    tr.appendChild(makeCell(meta ? formatDegree(meta.longitude) : '-', '경도', 'num'));
    tr.appendChild(makeCell(formatMeter(res.northing), 'X (북쪽 N)', 'num'));
    tr.appendChild(makeCell(formatMeter(res.easting), 'Y (동쪽 E)', 'num'));
    tr.appendChild(makeCell(res.epsg || '-', 'EPSG'));
    tr.appendChild(makeStatusCell(meta ? { status: res.status, message: res.message } : null));
    return tr;
  }

  function render() {
    renderQueued = false;
    const files = window.photoList.getFiles();
    badge.textContent = files.length + '건';

    tbody.textContent = '';
    if (files.length === 0) {
      tbody.appendChild(emptyRow); // 사진이 없으면 기존 빈 결과 안내를 다시 표시
      return;
    }
    const fragment = document.createDocumentFragment();
    files.forEach(function (file, index) {
      fragment.appendChild(buildRow(index + 1, file, cache.get(file)));
    });
    tbody.appendChild(fragment);
  }

  // 사진이 많을 때 불필요한 반복 그리기를 줄이기 위해 한 프레임에 한 번만 갱신
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(render);
  }

  // ---- EXIF 읽기: 아직 처리하지 않은 사진을 하나씩 순서대로 처리 ----
  async function processQueue() {
    working = true;
    try {
      for (;;) {
        const next = window.photoList.getFiles().find(function (file) { return !cache.has(file); });
        if (!next) break;

        let meta;
        try {
          meta = await window.ExifReader.readPhotoMeta(next);
        } catch (error) {
          meta = {
            fileName: next.name, latitude: null, longitude: null, dateTime: '',
            status: 'ERROR', message: error && error.message ? error.message : '처리 중 오류'
          };
        }
        cache.set(next, meta);
        scheduleRender();
      }
    } finally {
      working = false;
    }
  }

  document.addEventListener('photolistchange', function () {
    render(); // 목록이 바뀐 즉시 행을 보여 주고
    if (!working) processQueue(); // 새 사진의 EXIF를 이어서 읽음
  });

  // ---- 좌표계 변경 / 변환 실행 버튼: 다시 업로드하지 않고 표만 다시 계산 ----
  document.querySelectorAll('input[name="epsg"]').forEach(function (radio) {
    radio.addEventListener('change', render);
  });
  const runBtn = document.querySelector('.actions-row .btn-primary');
  if (runBtn) runBtn.addEventListener('click', render);

  // 변환 엔진 안내 (Proj4js 사용 여부)
  const hintEl = document.querySelector('.actions-row');
  if (hintEl && window.CoordTransform) {
    const note = document.createElement('span');
    note.className = 'hint';
    note.id = 'engine-note';
    note.style.display = 'block';
    note.style.width = '100%';
    note.textContent = '변환 엔진: ' + window.CoordTransform.getEngine().note;
    hintEl.appendChild(note);
  }

  // 현재 목록 순서대로 결과 제공. 기존 필드(fileName, latitude, longitude, dateTime, status, message)는 그대로이고
  // 4단계에서 easting, northing, x, y, dxf, epsg, exifStatus가 추가됨 (status는 변환 결과까지 반영한 최종 상태)
  //   easting / northing : 축 순서와 무관한 원본 이름 (동쪽 / 북쪽, m)
  //   x, y               : 화면·CSV 순서 (x = northing, y = easting)
  //   dxf.x, dxf.y       : DXF(AutoCAD) 순서 (x = easting, y = northing)
  window.photoResults = {
    getResults: function () {
      const epsg = selectedEpsg();
      return window.photoList.getFiles().map(function (file) {
        const meta = cache.get(file) ||
          { fileName: file.name, latitude: null, longitude: null, dateTime: '', status: 'PENDING', message: '' };
        const res = resolve(cache.get(file), epsg);
        return Object.assign({}, meta, {
          easting: res.easting, northing: res.northing,
          x: res.northing, y: res.easting,
          dxf: { x: res.easting, y: res.northing },
          epsg: res.epsg,
          exifStatus: meta.status, status: res.status, message: res.message
        });
      });
    }
  };

  render();
  if (window.photoList.getFiles().length > 0) processQueue();
})();