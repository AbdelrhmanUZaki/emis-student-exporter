/* StudentDataExporter - shared logic (no chrome.* usage at top level).
 * Loaded by the popup (script tag), the background service worker
 * (importScripts) and the Node test harness.
 */
'use strict';

const GRADE_NAMES = {
  1: 'الصف الأول',
  2: 'الصف الثاني',
  3: 'الصف الثالث',
  4: 'الصف الرابع',
  5: 'الصف الخامس',
  6: 'الصف السادس'
};
const API_URL = 'https://studaapi.emis.gov.eg/api/Student/GetSchoolStudent';

// ---------- Runs INSIDE the EMIS page: collect auth material, SYNCHRONOUSLY ----------
// MUST stay synchronous (no fetch/await): the caller relies on this function's direct
// return value, which every browser delivers reliably. Async injected results are not.
function collectAuthInPage() {
  const out = { captured: null, token: null, schoolcode: null, schoolstage: null, usertype: null, jwtClaims: null, lsCount: 0, ssCount: 0 };
  // 1) headers captured by headerHook.js from the app's own API calls (authoritative)
  try {
    const s = sessionStorage.getItem('emisCapturedHeaders');
    if (s) {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') {
        const cap = {};
        ['authorization', 'schoolcode', 'schoolstage', 'usertype'].forEach(function (k) { if (o[k]) cap[k] = String(o[k]); });
        if (Object.keys(cap).length) out.captured = cap;
      }
    }
  } catch (e) {}
  function deepSearch(obj, path) {
    if (!obj || typeof obj !== 'object' || path.length > 4) return;
    for (const k of Object.keys(obj).slice(0, 50)) {
      const kl = k.toLowerCase();
      const v = obj[k];
      const p = path.concat(k).join('.');
      if (typeof v === 'string') {
        if (!out.token) {
          const m = v.match(/eyJ[A-Za-z0-9\-_=]+\.eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+/);
          if (m) out.token = m[0];
        }
        if (!out.schoolcode && (kl.includes('schoolcode') || kl.includes('school_code')) && v.length >= 8 && v.length < 500) out.schoolcode = v;
        // schoolcode often looks like base64/url-encoded ending with == or %3D%3D
        if (!out.schoolcode && v.length >= 20 && v.length <= 200 && (/==$/.test(v) || /%3D%3D$/i.test(v) || /^[A-Za-z0-9%+/_=-]+$/.test(v))) {
          if (/school|code/i.test(p) || /school|code/i.test(v.slice(0, 20))) out.schoolcode = v;
        }
        if (!out.schoolstage && kl.includes('schoolstage') && v.length < 10) out.schoolstage = v;
        if (!out.usertype && kl.includes('usertype') && v.length < 10) out.usertype = v;
      } else if (v && typeof v === 'object') {
        deepSearch(v, path.concat(k));
      }
    }
  }
  const stores = [];
  try { stores.push(['local', localStorage]); } catch (e) {}
  try { stores.push(['session', sessionStorage]); } catch (e) {}
  for (const [sname, st] of stores) {
    try {
      const n = st.length;
      if (sname === 'local') out.lsCount = n; else out.ssCount = n;
      for (let i = 0; i < n; i++) {
        const k = st.key(i);
        let v = '';
        try { v = st.getItem(k); } catch (e) { continue; }
        if (!v || typeof v !== 'string') continue;
        const kl = k.toLowerCase();
        if (!out.token) {
          const m = v.match(/eyJ[A-Za-z0-9\-_=]+\.eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+/);
          if (m) out.token = m[0];
        }
        if (!out.token && (kl.includes('token') || kl.includes('access_token') || kl.includes('jwt') || kl.includes('bearer') || kl.includes('auth')) && v.length > 40) {
          const m = v.match(/eyJ[A-Za-z0-9\-_=]+\.eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+/);
          if (m) out.token = m[0];
        }
        if (!out.schoolcode && (kl.includes('schoolcode') || kl.includes('school_code')) && v.length < 500) out.schoolcode = v;
        if (!out.schoolstage && kl.includes('schoolstage') && v.length < 10) out.schoolstage = v;
        if (!out.usertype && kl.includes('usertype') && v.length < 10) out.usertype = v;
        // deep-parse JSON blobs like accountApp / MSAL cache
        if (v.length > 100 && (v[0] === '{' || v[0] === '[')) {
          try { deepSearch(JSON.parse(v), [sname + ':' + k]); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  // JWT payload may carry school claims (sid/schoolcode) — read school claims only
  if (out.token) {
    try {
      const parts = out.token.split('.');
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      out.jwtClaims = Object.keys(payload);
      for (const ck of Object.keys(payload)) {
        const ckl = ck.toLowerCase();
        if (!out.schoolcode && (ckl.includes('schoolcode') || ckl.includes('school_code'))) out.schoolcode = String(payload[ck]);
        if (!out.schoolstage && ckl.includes('schoolstage')) out.schoolstage = String(payload[ck]);
      }
    } catch (e) {}
  }
  // window globals (in-memory token case)
  try {
    for (const k of Object.keys(window)) {
      if (out.token) break;
      if (k.toLowerCase().includes('token') || k.toLowerCase().includes('auth')) {
        const v = String(window[k] || '').slice(0, 4000);
        const m = v.match(/eyJ[A-Za-z0-9\-_=]+\.eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+/);
        if (m && !out.token) out.token = m[0];
      }
    }
  } catch (e) {}
  return out;
}

// The app sends the Schoolcode header URL-encoded (e.g. ...%2F...%3D%3D);
// storage may hold the decoded form, so re-encode unless it already looks encoded.
function normalizeSchoolcode(sc) {
  if (!sc) return sc;
  if (/%[0-9A-Fa-f]{2}/.test(sc)) return sc;
  try { return encodeURIComponent(sc); } catch (e) { return sc; }
}

function buildApiHeaders(a) {
  const cap = (a && a.captured) || {};
  const h = {
    'Content-Type': 'application/json',
    'Schoolstage': cap.schoolstage || (a && a.schoolstage) || '2',
    'Usertype': cap.usertype || (a && a.usertype) || '0'
  };
  if (cap.authorization) h['Authorization'] = cap.authorization;
  else if (a && a.token) h['Authorization'] = 'Bearer ' + a.token;
  const sc = cap.schoolcode || normalizeSchoolcode(a && a.schoolcode);
  if (sc) h['Schoolcode'] = sc;
  return h;
}

// ---------- fallback: fetch INSIDE the page, stash result on window, poll sync ----------
function pageFetchStash(grade, headers) {
  (async () => {
    window.__emisExport = window.__emisExport || {};
    window.__emisExport['g' + grade] = { done: false };
    try {
      const res = await fetch('https://studaapi.emis.gov.eg/api/Student/GetSchoolStudent', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ acdYearCode: String(grade) }),
        credentials: 'include'
      });
      const status = res.status;
      let rows = null, err = '';
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) rows = data; else err = 'استجابة غير متوقعة (ليست قائمة)';
      } else {
        err = (await res.text().catch(() => '')).slice(0, 150);
      }
      window.__emisExport['g' + grade] = { done: true, ok: !!rows, status: status, rows: rows, err: err };
    } catch (e) {
      window.__emisExport = window.__emisExport || {};
      window.__emisExport['g' + grade] = { done: true, ok: false, status: 0, rows: null, err: String((e && e.message) || e) };
    }
  })();
  return true;
}
function pageFetchPoll(grade) {
  try {
    const e = window.__emisExport && window.__emisExport['g' + grade];
    return e ? JSON.parse(JSON.stringify(e)) : null;
  } catch (err) {
    return { done: true, ok: false, status: 0, rows: null, err: 'serial:' + err };
  }
}

// ---------- sorting: grade asc, then sex group, then classNumber, then name ----------
function sortStudents(rows, mode) {
  const sexRank = (s) => {
    const male = s.sexId === 1;
    if (mode === 'girls-first') return male ? 1 : 0;
    if (mode === 'alpha') return 0;
    return male ? 0 : 1; // boys-first default
  };
  return rows.slice().sort((a, b) => {
    if (a._grade !== b._grade) return a._grade - b._grade;
    const ra = sexRank(a), rb = sexRank(b);
    if (mode !== 'alpha' && ra !== rb) return ra - rb;
    if ((a.classNumber || 0) !== (b.classNumber || 0)) return (a.classNumber || 0) - (b.classNumber || 0);
    return String(a.studentName || '').localeCompare(String(b.studentName || ''), 'ar');
  });
}

// Birth-date + age values, replicating EXACTLY what the H..O formulas compute from the
// national ID (age at 1/10 of refYear). The formulas stay in the cells, but these
// pre-computed results are stored as their cached values — apps that don't recalculate
// on load (WPS / LibreOffice / viewers) then show real values instead of "غير محدد".
function calcBirthValues(nidStr, refYear) {
  const GM = 'غير محدد';
  const bad = { I: GM, J: GM, K: GM, L: GM, M: GM, N: GM, O: GM, P: GM };
  const s = String(nidStr || '');
  if (!/^\d{14}$/.test(s)) return bad;
  const c = s[0];
  if (c !== '2' && c !== '3') return bad;
  const mm = parseInt(s.slice(3, 5), 10);
  const dd = parseInt(s.slice(5, 7), 10);
  const y = (c === '2' ? 1900 : 2000) + parseInt(s.slice(1, 3), 10);
  // same sanity check as the formulas: DATE() must not roll over the month/day
  const dt = new Date(Date.UTC(y, mm - 1, dd));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return bad;
  const mComp = 10 - mm - (dd > 1 ? 1 : 0); // months between birthday and 1/10 (negative = before)
  const O = refYear - y - (mComp < 0 ? 1 : 0); // years
  if (O < 0) return bad;
  const M = dd > 1 ? 31 - dd : 1 - dd; // days part
  const N = ((mComp % 12) + 12) % 12; // months part (Excel MOD semantics)
  const pad2 = (n) => (n < 10 ? '0' + n : String(n));
  return {
    I: dd,
    J: mm,
    K: y,
    L: y + '/' + pad2(mm) + '/' + pad2(dd),
    M: M,
    N: N,
    O: O,
    P: pad2(O) + '/' + pad2(N) + '/' + pad2(M)
  };
}

// ---------- XLSX builder (store-only ZIP, no external libs) ----------
// Layout matches the v1 file minus the unused "عمود 7" column: 15 cols A..O,
// 2 header rows, formulas H..O derived from the national ID in $C.
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function crc32(bytes) {
  let table = crc32._t;
  if (!table) {
    table = crc32._t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function encUtf8(str) { return new TextEncoder().encode(str); }
function zipStore(files) {
  // files: [{name, data:Uint8Array}] — STORE (no compression), Excel-compatible
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new Uint8Array(30);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, 0, true); // STORE
    v.setUint16(10, 0, true);
    v.setUint16(12, 0, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, f.data.length, true);
    v.setUint32(22, f.data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    chunks.push(lh, nameBytes, f.data);
    central.push({ nameBytes, crc, size: f.data.length, offset });
    offset += 30 + nameBytes.length + f.data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const h = new Uint8Array(46);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, 0, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, 0, true);
    v.setUint16(14, 0, true);
    v.setUint32(16, c.crc, true);
    v.setUint32(20, c.size, true);
    v.setUint32(24, c.size, true);
    v.setUint16(28, c.nameBytes.length, true);
    v.setUint16(30, 0, true);
    v.setUint16(32, 0, true);
    v.setUint16(34, 0, true);
    v.setUint16(36, 0, true);
    v.setUint32(38, 0, true);
    v.setUint32(42, c.offset, true);
    chunks.push(h, c.nameBytes);
    cdSize += h.length + c.nameBytes.length;
    offset += h.length + c.nameBytes.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, central.length, true); end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, cdStart, true);
  end.setUint16(20, 0, true);
  chunks.push(new Uint8Array(end.buffer));
  let total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function buildXlsx(rows, refYear) {
  // shared strings
  const strings = [];
  const idx = new Map();
  const S = (v) => {
    v = v == null ? '' : String(v);
    if (!idx.has(v)) { idx.set(v, strings.length); strings.push(v); }
    return idx.get(v);
  };
  const H1 = ['كود التلميذ', 'اسم التلميذ', 'الرقم القومى', 'الصف', 'الفصل', 'الجنسيه', 'النوع', 'تاريخ الميلاد تفصيلا', '', '', 'تاريخ الميلاد كاملا', String(refYear), '', '', 'السن كاملا'];
  const H2 = ['', '', '', '', '', '', '', 'يوم', 'شهر', 'سنة', '', 'يوم', 'شهر', 'سنة', ''];
  H1.forEach(S); H2.forEach(S);
  S('غير محدد'); S('ذكر'); S('أنثى'); S('مصرى');
  for (const r of rows) {
    S(r.studentCode != null ? String(r.studentCode) : '');
    S(r.studentName || '');
    S(r.nationalId != null ? String(r.nationalId) : '');
    S(r.className || GRADE_NAMES[r._grade] || '');
    S(r.classNumber != null ? String(r.classNumber) : '');
    S(r.nationality || 'مصرى');
    S(r.sexId === 1 ? 'ذكر' : 'أنثى');
  }

  const ssXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + (rows.length * 7 + 30) + '" uniqueCount="' + strings.length + '">' +
    strings.map(s => '<si><t xml:space="preserve">' + escXml(s) + '</t></si>').join('') + '</sst>';

  // formulas per row, derived from $C national ID (15-col layout after removing عمود 7:
  // H=day, I=month, J=year, K=full date, L=age days, M=age months, N=age years [anchor $L$1], O=full age)
  const F = (r) => ({
    H: 'IFERROR(IF(AND(LEN($C' + r + ')=14,OR(LEFT($C' + r + ',1)="2",LEFT($C' + r + ',1)="3"),MONTH(DATE((IF(LEFT($C' + r + ',1)="2",1900,2000)+VALUE(MID($C' + r + ',2,2))),VALUE(MID($C' + r + ',4,2)),VALUE(MID($C' + r + ',6,2))))=VALUE(MID($C' + r + ',4,2)),DAY(DATE((IF(LEFT($C' + r + ',1)="2",1900,2000)+VALUE(MID($C' + r + ',2,2))),VALUE(MID($C' + r + ',4,2)),VALUE(MID($C' + r + ',6,2))))=VALUE(MID($C' + r + ',6,2))),VALUE(MID($C' + r + ',6,2)),"غير محدد"),"غير محدد")',
    I: 'IFERROR(IF(AND(LEN($C' + r + ')=14,OR(LEFT($C' + r + ',1)="2",LEFT($C' + r + ',1)="3"),MONTH(DATE((IF(LEFT($C' + r + ',1)="2",1900,2000)+VALUE(MID($C' + r + ',2,2))),VALUE(MID($C' + r + ',4,2)),VALUE(MID($C' + r + ',6,2))))=VALUE(MID($C' + r + ',4,2)),DAY(DATE((IF(LEFT($C' + r + ',1)="2",1900,2000)+VALUE(MID($C' + r + ',2,2))),VALUE(MID($C' + r + ',4,2)),VALUE(MID($C' + r + ',6,2))))=VALUE(MID($C' + r + ',6,2))),VALUE(MID($C' + r + ',4,2)),"غير محدد"),"غير محدد")',
    J: 'IFERROR(IF(AND(LEN($C' + r + ')=14,OR(LEFT($C' + r + ',1)="2",LEFT($C' + r + ',1)="3"),MONTH(DATE((IF(LEFT($C' + r + ',1)="2",1900,2000)+VALUE(MID($C' + r + ',2,2))),VALUE(MID($C' + r + ',4,2)),VALUE(MID($C' + r + ',6,2))))=VALUE(MID($C' + r + ',4,2)),DAY(DATE((IF(LEFT($C' + r + ',1)="2",1900,2000)+VALUE(MID($C' + r + ',2,2))),VALUE(MID($C' + r + ',4,2)),VALUE(MID($C' + r + ',6,2))))=VALUE(MID($C' + r + ',6,2))),(IF(LEFT($C' + r + ',1)="2",1900,2000)+VALUE(MID($C' + r + ',2,2))),"غير محدد"),"غير محدد")',
    K: 'IFERROR(IF(ISNUMBER(J' + r + '),J' + r + '&"/"&RIGHT("0"&I' + r + ',2)&"/"&RIGHT("0"&H' + r + ',2),"غير محدد"),"غير محدد")',
    L: 'IFERROR(IF(ISNUMBER(N' + r + '),IF(H' + r + '>1,31-H' + r + ',1-H' + r + '),"غير محدد"),"غير محدد")',
    M: 'IFERROR(IF(ISNUMBER(N' + r + '),MOD(10-I' + r + '-IF(H' + r + '>1,1,0),12),"غير محدد"),"غير محدد")',
    N: 'IFERROR(IF(ISNUMBER(J' + r + '),IF($L$1-J' + r + '-IF(10-I' + r + '-IF(H' + r + '>1,1,0)<0,1,0)<0,"غير محدد",$L$1-J' + r + '-IF(10-I' + r + '-IF(H' + r + '>1,1,0)<0,1,0)),"غير محدد"),"غير محدد")',
    O: 'IFERROR(IF(ISNUMBER(N' + r + '),RIGHT("0"&N' + r + ',2)&"/"&RIGHT("0"&M' + r + ',2)&"/"&RIGHT("0"&L' + r + ',2),"غير محدد"),"غير محدد")'
  });

  const col = (letter, style, val, isStr) => {
    if (val === '' || val == null) return '<c r="' + letter + '" s="' + style + '"/>';
    if (isStr) return '<c r="' + letter + '" s="' + style + '" t="s"><v>' + val + '</v></c>';
    return '<c r="' + letter + '" s="' + style + '"><v>' + escXml(val) + '</v></c>';
  };
  const fcell = (letter, style, formula, val) => {
    if (typeof val === 'number') {
      return '<c r="' + letter + '" s="' + style + '"><f>' + escXml(formula) + '</f><v>' + val + '</v></c>';
    }
    return '<c r="' + letter + '" s="' + style + '" t="str"><f>' + escXml(formula) + '</f><v xml:space="preserve">' + escXml(val) + '</v></c>';
  };

  let sheetData = '';
  // header row 1 (styles 1/2/3 like v1)
  sheetData += '<row r="1" ht="24" customHeight="1">';
  const h1styles = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 2];
  const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];
  H1.forEach((h, i) => {
    const L = cols[i], st = h1styles[i];
    if (i === 11) sheetData += '<c r="L1" s="3"><v>' + refYear + '</v></c>';
    else if (h === '') sheetData += '<c r="' + L + '1" s="' + st + '"/>';
    else sheetData += '<c r="' + L + '1" s="' + st + '" t="s"><v>' + S(h) + '</v></c>';
  });
  sheetData += '</row>';
  // header row 2
  sheetData += '<row r="2" ht="24" customHeight="1">';
  H2.forEach((h, i) => {
    const L = cols[i];
    if (h === '') sheetData += '<c r="' + L + '2" s="2"/>';
    else sheetData += '<c r="' + L + '2" s="2" t="s"><v>' + S(h) + '</v></c>';
  });
  sheetData += '</row>';
  // data rows: colour follows GENDER — boys skyblue (style 6), girls pink (style 5)
  rows.forEach((r, i) => {
    const rn = i + 3;
    const dataStyle = (r.sexId === 1) ? 6 : 5;
    const f = F(rn);
    sheetData += '<row r="' + rn + '">';
    sheetData += col('A' + rn, dataStyle, S(r.studentCode != null ? String(r.studentCode) : ''), true);
    sheetData += col('B' + rn, dataStyle, S(r.studentName || ''), true);
    const nid = r.nationalId != null ? String(r.nationalId) : '';
    const bv = calcBirthValues(nid, refYear);
    sheetData += nid ? col('C' + rn, dataStyle, S(nid), true) : '<c r="C' + rn + '" s="' + dataStyle + '"/>';
    sheetData += col('D' + rn, dataStyle, S(r.className || GRADE_NAMES[r._grade] || ''), true);
    sheetData += col('E' + rn, dataStyle, S(r.classNumber != null ? String(r.classNumber) : ''), true);
    sheetData += col('F' + rn, dataStyle, S(r.nationality || 'مصرى'), true);
    sheetData += col('G' + rn, dataStyle, S(r.sexId === 1 ? 'ذكر' : 'أنثى'), true);
    sheetData += fcell('H' + rn, dataStyle, f.H, bv.I);
    sheetData += fcell('I' + rn, dataStyle, f.I, bv.J);
    sheetData += fcell('J' + rn, dataStyle, f.J, bv.K);
    sheetData += fcell('K' + rn, dataStyle, f.K, bv.L);
    sheetData += fcell('L' + rn, dataStyle, f.L, bv.M);
    sheetData += fcell('M' + rn, dataStyle, f.M, bv.N);
    sheetData += fcell('N' + rn, dataStyle, f.N, bv.O);
    sheetData += fcell('O' + rn, dataStyle, f.O, bv.P);
    sheetData += '</row>';
  });

  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="14.25"/><cols><col customWidth="1" min="1" max="1" width="14"/><col customWidth="1" min="2" max="2" width="42"/><col customWidth="1" min="3" max="3" width="17"/><col customWidth="1" min="4" max="4" width="13"/><col customWidth="1" min="5" max="5" width="8"/><col customWidth="1" min="6" max="6" width="10"/><col customWidth="1" min="7" max="7" width="10"/><col customWidth="1" min="8" max="10" width="9"/><col customWidth="1" min="11" max="11" width="15"/><col customWidth="1" min="12" max="14" width="9"/><col customWidth="1" min="15" max="15" width="15"/></cols>' +
    '<sheetData>' + sheetData + '</sheetData></worksheet>';

  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;السن في 1/10/&quot;0"/></numFmts><fonts count="2"><font><sz val="11.000000"/><name val="Arial"/></font><font><b/><sz val="11.000000"/><color indexed="65"/><name val="Arial"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4CAF50"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFF9800"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE6F0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F3FF"/></patternFill></fill></fills><borders count="2"><border><left style="none"/><right style="none"/><top style="none"/><bottom style="none"/><diagonal style="none"/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal style="none"/></border></borders><cellStyleXfs count="1"><xf fontId="0" fillId="0" borderId="0" numFmtId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/></cellStyleXfs><cellXfs count="7"><xf fontId="0" fillId="0" borderId="0" numFmtId="0" xfId="0"/><xf fontId="1" fillId="2" borderId="1" numFmtId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf fontId="1" fillId="3" borderId="1" numFmtId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf fontId="1" fillId="3" borderId="1" numFmtId="164" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf fontId="0" fillId="0" borderId="1" numFmtId="0" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf><xf fontId="0" fillId="4" borderId="1" numFmtId="0" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf><xf fontId="0" fillId="5" borderId="1" numFmtId="0" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="بيانات الطلاب" sheetId="1" state="visible" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><cp:lastModifiedBy>StudentDataExporter</cp:lastModifiedBy></cp:coreProperties>';
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>StudentDataExporter v3.0</Application></Properties>';

  return zipStore([
    { name: '[Content_Types].xml', data: encUtf8(contentTypes) },
    { name: '_rels/.rels', data: encUtf8(rels) },
    { name: 'xl/workbook.xml', data: encUtf8(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: encUtf8(wbRels) },
    { name: 'xl/worksheets/sheet1.xml', data: encUtf8(sheetXml) },
    { name: 'xl/sharedStrings.xml', data: encUtf8(ssXml) },
    { name: 'xl/styles.xml', data: encUtf8(stylesXml) },
    { name: 'docProps/core.xml', data: encUtf8(core) },
    { name: 'docProps/app.xml', data: encUtf8(app) }
  ]);
}

// expose for testing in Node (ignored in browser)
try { if (typeof module !== 'undefined') { module.exports = { GRADE_NAMES, API_URL, collectAuthInPage, normalizeSchoolcode, buildApiHeaders, pageFetchStash, pageFetchPoll, sortStudents, calcBirthValues, buildXlsx }; } } catch (e) {}
