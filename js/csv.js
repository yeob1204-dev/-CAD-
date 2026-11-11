/* ===== CSV 내보내기 (6단계) =====
 * window.photoResults.getResults()의 결과를 CSV 파일로 내려받습니다.
 * 열 순서: No, 파일명, 촬영 일시, 위도, 경도, X (북쪽 N), Y (동쪽 E), EPSG, 상태
 * X = northing, Y = easting (화면과 동일). 파일은 브라우저 안에서만 만들어지며 어디로도 전송되지 않습니다.
 */
(function () {
  'use strict';

  const btn = document.getElementById('csv-btn');
  const note = document.querySelector('.footer-note');
  if (!btn) return;

  const HEADER = ['No', '파일명', '촬영 일시', '위도', '경도', 'X (북쪽 N)', 'Y (동쪽 E)', 'EPSG', '상태'];
  const DEFAULT_NOTE = note ? note.textContent : '';
  let noteTimer = null;

  function showNote(text) {
    if (!note) return;
    note.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { note.textContent = DEFAULT_NOTE; }, 6000);
  }

  // 쉼표, 큰따옴표, 줄바꿈이 있으면 큰따옴표로 감싸고 내부 큰따옴표는 두 번 씀
  function escapeCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function fixed(value, digits) {
    return typeof value === 'number' && isFinite(value) ? value.toFixed(digits) : '';
  }

  function toRow(item, index) {
    return [
      index + 1,
      item.fileName,
      item.dateTime || '',
      fixed(item.latitude, 6),
      fixed(item.longitude, 6),
      fixed(item.northing, 3), // X = Northing
      fixed(item.easting, 3),  // Y = Easting
      item.epsg || '',
      item.status
    ];
  }

  function buildCsv(results) {
    const lines = [HEADER].concat(results.map(toRow)).map(function (row) {
      return row.map(escapeCell).join(',');
    });
    return lines.join('\r\n') + '\r\n';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fileName() {
    const d = new Date();
    return 'photo-coordinates-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.csv';
  }

  function download(text) {
    const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }); // UTF-8 BOM
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName();
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000); // Object URL 정리
  }

  function exportCsv() {
    if (!window.photoResults) { showNote('결과 데이터를 불러오지 못했습니다.'); return; }
    let results;
    try {
      results = window.photoResults.getResults();
    } catch (error) {
      showNote('결과 데이터를 읽는 중 오류가 발생했습니다.');
      return;
    }
    if (results.length === 0) { showNote('내보낼 사진이 없습니다. 사진을 먼저 업로드하세요.'); return; }
    if (results.some(function (r) { return r.status === 'PENDING'; })) {
      showNote('아직 처리 중인 사진이 있습니다. 처리가 끝난 뒤 다시 시도하세요.');
      return;
    }
    try {
      download(buildCsv(results));
      showNote('CSV ' + results.length + '건을 저장했습니다.');
    } catch (error) {
      showNote('CSV 저장 중 오류가 발생했습니다.');
    }
  }

  btn.disabled = false;
  btn.addEventListener('click', exportCsv);
})();