/* ===== 좌표계 변환 (4단계) =====
 * WGS84(EPSG:4326, 경도·위도 순서) → EPSG:5179 / 5186 / 5181 / 5187 (단위 m)
 * 내부 결과는 축 순서와 무관한 이름으로만 관리합니다: easting(동쪽), northing(북쪽).
 * 표시·CSV의 X/Y 배치와 DXF의 X/Y 배치는 이 값을 쓰는 쪽(results.js 등)에서 정합니다.
 *
 * 계산 엔진
 *   1) Proj4js(CDN, 버전 고정)가 로드되어 있고, 내장 검증표와 1 mm 이내로 일치하면 Proj4js를 사용합니다.
 *   2) Proj4js가 없거나(오프라인 등) 검증표와 맞지 않으면 내장 Transverse Mercator(Krüger 급수) 엔진을 사용합니다.
 * 어떤 경우에도 사진·좌표는 외부로 전송되지 않습니다.
 */
(function () {
  'use strict';

  // ---- EPSG 정의 (공통: GRS80 a=6378137, 1/f=298.257222101, 단위 m) ----
  const GRS80 = { a: 6378137, invf: 298.257222101 };
  const DEFINITIONS = {
    '5179': { name: '통합좌표계(UTM-K)', lat0: 38, lon0: 127.5, k0: 0.9996, fe: 1000000, fn: 2000000 },
    '5186': { name: '중부원점(2010)', lat0: 38, lon0: 127, k0: 1, fe: 200000, fn: 600000 },
    '5181': { name: '중부원점(구 좌표계)', lat0: 38, lon0: 127, k0: 1, fe: 200000, fn: 500000 },
    '5187': { name: '동부원점(2010)', lat0: 38, lon0: 129, k0: 1, fe: 200000, fn: 600000 }
  };
  Object.keys(DEFINITIONS).forEach(function (code) {
    const d = DEFINITIONS[code];
    d.proj4 = '+proj=tmerc +lat_0=' + d.lat0 + ' +lon_0=' + d.lon0 + ' +k=' + d.k0 +
      ' +x_0=' + d.fe + ' +y_0=' + d.fn +
      ' +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
  });

  // ---- 독립 기준값 (정밀 수치해석 프로그램으로 산출, 값은 [easting(동), northing(북)] m) ----
  const REFERENCE = [
    { label: "서울 부근", lat: 37.5662952, lon: 126.9779692, ref: { "5179": [953898.3190654437, 1952009.3745349143], "5186": [198053.6403217785, 551862.3008244], "5181": [198053.6403217785, 451862.30082440004], "5187": [21349.616440526937, 553784.4688377357] } },
    { label: "부산 부근", lat: 35.1798, lon: 129.075, ref: { "5179": [1143412.3901620975, 1688303.2990943522], "5186": [389021.67519238486, 289014.80842642905], "5181": [389021.67519238486, 189014.80842642905], "5187": [206831.6031371555, 287044.8701498662] } },
    { label: "제주 부근", lat: 33.4996, lon: 126.5312, ref: { "5179": [910010.5457116978, 1501279.7888660098], "5186": [156437.51964552669, 100758.48149363883], "5181": [156437.51964552669, 758.4814936388284], "5187": [-29436.1916958582, 103389.36086700438] } },
    { label: "강릉 부근", lat: 37.7519, lon: 128.8761, ref: { "5179": [1121226.7473909163, 1973364.7603698655], "5186": [365343.5494752425, 574120.0442944001], "5181": [365343.5494752425, 474120.04429440014], "5187": [189080.99552807014, 572469.5842429455] } },
    { label: "목포 부근", lat: 34.8118, lon: 126.3922, ref: { "5179": [898678.2921406043, 1646916.9335712432], "5186": [144387.94462791248, 246384.58712030342], "5181": [144387.94462791248, 146384.58712030342], "5187": [-38633.994581913255, 249317.73862535413] } },
    { label: "울릉도 부근", lat: 37.4844, lon: 130.9057, ref: { "5179": [1301139.079825169, 1948245.7290940923], "5186": [545505.058395522, 549945.3338103457], "5181": [545505.058395522, 449945.33381034574], "5187": [368555.5587221314, 544478.9250645647] } },
    { label: "독도 부근(동쪽 끝)", lat: 37.2394, lon: 131.8669, ref: { "5179": [1387429.1791573379, 1924559.779256195], "5186": [631988.9374323509, 526699.6439450886], "5181": [631988.9374323509, 426699.6439450886], "5187": [454413.9531966297, 519435.1597306966] } },
    { label: "백령도 부근(서쪽 끝)", lat: 37.9667, lon: 124.7167, ref: { "5179": [755499.643818209, 1999960.4022158545], "5186": [-651.5457443149062, 598764.2043035077], "5181": [-651.5457443149062, 498764.2043035077], "5187": [-176468.74115450477, 604970.0769069865] } },
    { label: "원점 5179 (정의상 FE,FN)", lat: 38.0, lon: 127.5, ref: { "5179": [1000000.0, 2000000.0], "5186": [243916.36680917256, 600117.9755438697], "5181": [243916.36680917256, 500117.97554386966], "5187": [68247.62958266906, 601061.9281046316] } },
    { label: "원점 5186 (정의상 FE,FN)", lat: 38.0, lon: 127.0, ref: { "5179": [956101.1997375512, 2000117.9283536521], "5186": [200000.0, 600000.0], "5181": [200000.0, 500000.0], "5187": [24326.35975135048, 601888.1027669143] } },
    { label: "원점 5181 (정의상 FE,FN)", lat: 38.0, lon: 127.0, ref: { "5179": [956101.1997375512, 2000117.9283536521], "5186": [200000.0, 600000.0], "5181": [200000.0, 500000.0], "5187": [24326.35975135048, 601888.1027669143] } },
    { label: "원점 5187 (정의상 FE,FN)", lat: 38.0, lon: 129.0, ref: { "5179": [1131699.669469164, 2001061.5033333898], "5186": [375673.6402486495, 601888.1027669143], "5181": [375673.6402486495, 501888.1027669143], "5187": [200000.0, 600000.0] } }
  ];

  // ---- 내장 엔진: Transverse Mercator, Krüger n-급수 6차 (Karney 2011) ----
  const RAD = Math.PI / 180;
  const n0 = 1 / (2 * GRS80.invf - 1); // n = f / (2 - f)
  const f0 = 1 / GRS80.invf;
  const e0 = Math.sqrt(f0 * (2 - f0));
  const n = n0, n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = GRS80.a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
    13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
    61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
    49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
    34729 * n5 / 80640 - 3418889 * n6 / 1995840,
    212378941 * n6 / 319334400
  ];

  function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }
  function asinh(x) { return Math.log(x + Math.sqrt(x * x + 1)); }

  // 위도 phi, 중앙경선과의 경도차 lam(라디안) → 정규화된 (xi, eta)
  function xiEta(phi, lam) {
    const s = Math.sin(phi);
    const t = Math.sinh(atanh(s) - e0 * atanh(e0 * s));
    const xi1 = Math.atan2(t, Math.cos(lam));
    const eta1 = asinh(Math.sin(lam) / Math.hypot(t, Math.cos(lam)));
    let xi = xi1, eta = eta1;
    for (let j = 1; j <= 6; j++) {
      xi += alpha[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
      eta += alpha[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
    }
    return { xi: xi, eta: eta };
  }

  function builtinTransform(lon, lat, code) {
    const d = DEFINITIONS[code];
    const o = xiEta(d.lat0 * RAD, 0);
    const p = xiEta(lat * RAD, (lon - d.lon0) * RAD);
    return [d.fe + d.k0 * A * p.eta, d.fn + d.k0 * A * (p.xi - o.xi)];
  }

  // ---- Proj4js 어댑터 ----
  let proj4Ok = false;
  let engineNote = '내장 엔진(Proj4js 미사용)';
  let engineName = 'builtin';

  function checkProj4() {
    proj4Ok = false;
    engineName = 'builtin';
    const p4 = (typeof window !== 'undefined') ? window.proj4 : undefined;
    if (typeof p4 !== 'function') {
      engineNote = 'Proj4js를 불러오지 못해 내장 변환 엔진을 사용 중입니다. (인터넷 연결 확인)';
      return;
    }
    try {
      Object.keys(DEFINITIONS).forEach(function (code) {
        p4.defs('EPSG:' + code, DEFINITIONS[code].proj4);
      });
      p4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
      let worst = 0;
      REFERENCE.forEach(function (row) {
        Object.keys(row.ref).forEach(function (code) {
          const r = p4('EPSG:4326', 'EPSG:' + code, [row.lon, row.lat]);
          if (!r || !isFinite(r[0]) || !isFinite(r[1])) throw new Error('비정상 결과');
          worst = Math.max(worst, Math.abs(r[0] - row.ref[code][0]), Math.abs(r[1] - row.ref[code][1]));
        });
      });
      if (worst <= 0.001) {
        proj4Ok = true;
        engineName = 'proj4js';
        engineNote = 'Proj4js ' + (p4.version || '') + ' 사용 중 (기준값 대비 최대 오차 ' + worst.toFixed(6) + ' m)';
      } else {
        engineNote = 'Proj4js 결과가 기준값과 ' + worst.toFixed(4) + ' m 차이나 내장 변환 엔진을 사용 중입니다.';
      }
    } catch (err) {
      engineNote = 'Proj4js 점검 실패(' + (err && err.message) + ')로 내장 변환 엔진을 사용 중입니다.';
    }
  }

  // ---- 공개 함수 ----
  function transform(lon, lat, epsg) {
    const code = String(epsg).replace(/^EPSG:/i, '');
    if (!Object.prototype.hasOwnProperty.call(DEFINITIONS, code)) {
      throw new Error('지원하지 않는 좌표계: ' + epsg);
    }
    if (typeof lon !== 'number' || typeof lat !== 'number' || !isFinite(lon) || !isFinite(lat)) {
      throw new Error('좌표가 숫자가 아닙니다');
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error('좌표 범위 오류 (위도 ±90, 경도 ±180)');
    }
    let r;
    if (proj4Ok) {
      r = window.proj4('EPSG:4326', 'EPSG:' + code, [lon, lat]); // 경도, 위도 순서
    } else {
      r = builtinTransform(lon, lat, code);
    }
    if (!r || !isFinite(r[0]) || !isFinite(r[1])) throw new Error('변환 결과가 유효하지 않습니다');
    return { easting: r[0], northing: r[1], epsg: 'EPSG:' + code };
  }

  // 콘솔 자체 점검: CoordTransform.selfTest() → 표와 최대 오차 출력
  function selfTest() {
    const rows = [];
    let worst = 0;
    REFERENCE.forEach(function (row) {
      Object.keys(row.ref).forEach(function (code) {
        const r = transform(row.lon, row.lat, code);
        const b = builtinTransform(row.lon, row.lat, code);
        const dx = r.easting - row.ref[code][0], dy = r.northing - row.ref[code][1];
        worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
        rows.push({ 지점: row.label, EPSG: code, '동쪽 E 오차(m)': dx, '북쪽 N 오차(m)': dy,
          '내장엔진 X오차': b[0] - row.ref[code][0], '내장엔진 Y오차': b[1] - row.ref[code][1] });
      });
    });
    if (typeof console !== 'undefined' && console.table) console.table(rows);
    return { engine: engineName, note: engineNote, maxError_m: worst, rows: rows.length };
  }

  checkProj4();

  window.CoordTransform = {
    DEFINITIONS: DEFINITIONS,
    transform: transform,
    selfTest: selfTest,
    recheck: checkProj4,
    getEngine: function () { return { name: engineName, note: engineNote }; },
    _builtin: builtinTransform,
    _reference: REFERENCE
  };
})();