/* ===== 사진 업로드 / 목록 관리 (2단계) =====
 * 이 파일의 범위: 사진 선택, 드래그 앤 드롭, 형식 검사, 목록 표시, 목록 비우기
 * 하지 않는 일: EXIF/GPS 읽기, 좌표 변환, 저장, 서버 전송
 * 파일은 브라우저 메모리에만 보관되며 어디로도 전송되지 않습니다.
 */
(function () {
  'use strict';

  // ---- 설정 ----
  const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
  const ALLOWED_LABEL = 'JPG, JPEG, PNG, WebP, HEIC, HEIF';
  const MAX_NAMES_IN_MESSAGE = 3;

  // ---- 요소 ----
  const input = document.getElementById('photo-input');
  const dropzone = document.querySelector('.dropzone');
  const countEl = document.getElementById('photo-count');
  const clearBtn = document.getElementById('clear-btn');
  const listEl = document.getElementById('file-list');
  const messageEl = document.getElementById('upload-message');

  if (!input || !dropzone || !countEl || !clearBtn || !listEl || !messageEl) {
    return; // 필요한 요소가 없으면 아무 것도 하지 않음
  }

  // ---- 상태 (브라우저 메모리에만 보관) ----
  let photos = [];          // 목록에 추가된 File 객체
  let dragDepth = 0;

  // ---- 형식 검사: 확장자 + MIME 종류만 확인 (파일 내용은 읽지 않음) ----
  function getExtension(name) {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function isPhotoFile(file) {
    const ext = getExtension(file.name || '');
    if (!ALLOWED_EXTENSIONS.includes(ext)) return false;

    const type = (file.type || '').toLowerCase();
    if (type === '' || type.startsWith('image/')) return true;
    // 일부 환경에서는 HEIC/HEIF의 MIME 종류가 일반 바이너리로 전달됨
    if (type === 'application/octet-stream' && (ext === 'heic' || ext === 'heif')) return true;
    return false;
  }

  // ---- 목록 추가 ----
  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const rejected = [];
    let added = 0;

    files.forEach(function (file) {
      if (!isPhotoFile(file)) {
        rejected.push(file.name || '(이름 없음)');
        return;
      }
      photos.push(file);
      added += 1;
    });

    render();
    showMessage(added, rejected);
  }

  // ---- 목록 비우기 ----
  function clearPhotos() {
    photos = [];
    input.value = ''; // 같은 사진을 다시 선택할 수 있도록 초기화
    hideMessage();
    render();
  }

  // ---- 화면 갱신 ----
  function render() {
    countEl.textContent = String(photos.length);
    clearBtn.disabled = photos.length === 0;

    const fragment = document.createDocumentFragment();
    photos.forEach(function (file, index) {
      const li = document.createElement('li');

      const no = document.createElement('span');
      no.className = 'file-index';
      no.textContent = String(index + 1);

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name; // textContent 사용 (HTML로 해석되지 않음)
      name.title = file.name;

      li.appendChild(no);
      li.appendChild(name);
      fragment.appendChild(li);
    });

    listEl.textContent = '';
    listEl.appendChild(fragment);
    listEl.hidden = photos.length === 0;

    // 목록이 바뀌었음을 다른 스크립트(EXIF 결과 표시)에 알림
    document.dispatchEvent(new CustomEvent('photolistchange'));
  }

  // ---- 안내 메시지 ----
  function summarizeNames(names) {
    const shown = names.slice(0, MAX_NAMES_IN_MESSAGE).join(', ');
    const rest = names.length - MAX_NAMES_IN_MESSAGE;
    return rest > 0 ? shown + ' 외 ' + rest + '개' : shown;
  }

  function showMessage(added, rejected) {
    const lines = [];

    if (added > 0) {
      lines.push('사진 ' + added + '장을 목록에 추가했습니다.');
    }
    if (rejected.length > 0) {
      lines.push(
        '사진이 아닌 파일 ' + rejected.length + '개는 제외했습니다: ' + summarizeNames(rejected) +
        ' (지원 형식: ' + ALLOWED_LABEL + ')'
      );
    }
    messageEl.textContent = '';
    lines.forEach(function (text) {
      const line = document.createElement('div');
      line.textContent = text;
      messageEl.appendChild(line);
    });

    messageEl.classList.toggle('is-warn', rejected.length > 0);
    messageEl.classList.toggle('is-info', rejected.length === 0);
    messageEl.hidden = lines.length === 0;
  }

  function hideMessage() {
    messageEl.textContent = '';
    messageEl.hidden = true;
    messageEl.classList.remove('is-warn', 'is-info');
  }

  // ---- 파일 선택 ----
  input.addEventListener('change', function () {
    addFiles(input.files);
    input.value = ''; // 같은 파일을 다시 선택해도 change 이벤트가 발생하도록 초기화
  });

  clearBtn.addEventListener('click', clearPhotos);

  // ---- 드래그 앤 드롭 ----
  function hasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.from(types).includes('Files');
  }

  function setDragover(on) {
    dropzone.classList.toggle('is-dragover', on);
  }

  dropzone.addEventListener('dragenter', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragover(true);
  });

  dropzone.addEventListener('dragover', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  dropzone.addEventListener('dragleave', function (event) {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragover(false);
  });

  dropzone.addEventListener('drop', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragover(false);
    addFiles(event.dataTransfer.files);
  });

  // 업로드 영역 밖에 놓은 파일을 브라우저가 열거나 이동하지 않도록 차단
  window.addEventListener('dragover', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!dropzone.contains(event.target)) {
      event.dataTransfer.dropEffect = 'none';
    }
  });

  window.addEventListener('drop', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragover(false);
  });

  // 초기 상태 표시
  render();

  // 다음 단계에서 목록을 읽을 수 있도록 읽기 전용 접근만 제공
  window.photoList = {
    getFiles: function () { return photos.slice(); }
  };
})();