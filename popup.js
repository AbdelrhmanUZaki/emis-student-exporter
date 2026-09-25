/* StudentDataExporter v2.10 - readable source (no obfuscation)
 * One-click batch export: grades 1..6 (الابتدائي) -> single sheet, boys-first then girls per grade.
 * Data source: POST https://studaapi.emis.gov.eg/api/Student/GetSchoolStudent {acdYearCode:"1".."6"}
 *
 * v2.10: filename is now ابتدائي-كل-الفصول-<YYYY-MM-DD-HH-MM>.xlsx (no spaces).
 * v2.9: popup label clarifies the grades are الابتدائي (primary).
 * v2.8: removed the unused "عمود 7" column -> the sheet is now 15 columns A..O and all
 *       cell references in the H..O formulas were re-mapped (year anchor is $L$1).
 * v2.7: removed the diagnostics button/output; simplified popup UI for non-technical users.
 * v2.6: fixed filename "كل الفصول <YYYY-MM-DD HH-MM>.xlsx" (local time) downloaded via an
 *       anchor (chrome.downloads + blob: URLs can save as the blob UUID); removed the
 *       filename and year fields — the age cutoff (السن في 1/10) is always the current year.
 * v2.5: the age-cutoff year (السن في 1/10) now defaults to the CURRENT year automatically
 *       (it was hard-coded to 2026); the field stays editable for special cases.
 * v2.4: the gender fill now covers the FULL row (A..P), previously it started at النوع (H).
 * v2.3: row colour now follows gender (boys skyblue, girls pink) instead of alternating.
 *
 * v2.2: the birth-date/age columns (I..P) are Excel formulas; v2.1 shipped them with a
 * cached value of "غير محدد", so apps that don't recalculate on load (WPS, LibreOffice,
 * viewers) showed that everywhere. The values are now pre-computed in JS and stored as
 * the cells' cached results (formulas kept, so Excel still recalculates on edits).
 *
 * v2.1 (Chrome):
 * - The API request is now made from the popup itself (host_permissions bypass CORS).
 *   All HTTP errors are real catchable errors -> always visible in the UI.
 * - Auth (Bearer token + Schoolcode/Schoolstage/Usertype) is read from the open EMIS
 *   page with a SYNCHRONOUS injection (MAIN world first, ISOLATED fallback).
 *   v2.0 relied on the return value of an ASYNC injected function; when the browser
 *   drops that result the old code silently produced {rows:[], dbg:'no-result'} for
 *   every grade (0 students) instead of a real error. No async injected results anymore.
 * - Automatic fallback: if the popup fetch is rejected, the fetch runs inside the page
 *   (page origin + cookies) and the popup polls the stashed result with sync injections.
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

let lastFailedGrades = [];
let cachedSuccess = new Map(); // grade -> rows (kept across retry so retry merges, never discards)
let cancelled = false;

// ---------- UI wiring ----------
function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
on('allBtn', 'click', () => setAllGrades(true));
on('noneBtn', 'click', () => setAllGrades(false));
on('exportBtn', 'click', () => runExport(false));
on('retryBtn', 'click', () => runExport(true));
on('cancelBtn', 'click', () => { cancelled = true; setStatus('جاري الإلغاء...'); });

function setFormEnabled(v) {
  for (let g = 1; g <= 6; g++) document.getElementById('grade-' + g).disabled = !v;
  document.getElementById('sort').disabled = !v;
  document.getElementById('allBtn').disabled = !v;
  document.getElementById('noneBtn').disabled = !v;
  document.getElementById('cancelBtn').style.display = v ? 'none' : 'block';
}

function setAllGrades(v) {
  for (let g = 1; g <= 6; g++) document.getElementById('grade-' + g).checked = v;
}
function selectedGrades() {
  const out = [];
  for (let g = 1; g <= 6; g++) if (document.getElementById('grade-' + g).checked) out.push(g);
  return out;
}
function setStatus(t) { document.getElementById('status').textContent = t || ''; }
function setCounts(t) { document.getElementById('counts').textContent = t || ''; }
function setProgress(done, total) {
  const bar = document.getElementById('progress');
  const fill = document.getElementById('progressBar');
  if (!total) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  fill.style.width = Math.round((done / total) * 100) + '%';
}

// ---------- Runs INSIDE the EMIS page: collect auth material, SYNCHRONOUSLY ----------
// MUST stay synchronous (no fetch/await): the popup relies on this function's direct
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

// ---------- popup-side auth + fetch helpers ----------
async function readPageAuth(tab) {
  const attempts = [];
  let partial = null;
  for (const world of ['MAIN', 'ISOLATED']) {
    let res = null, err = null;
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: world, func: collectAuthInPage });
      res = (r && r[0] && r[0].result) || null;
    } catch (e) { err = String((e && e.message) || e); }
    attempts.push(world + '=' + (res ? 'ok' : 'ERR: ' + String(err || '').slice(0, 80)));
    const hasAuth = res && ((res.captured && res.captured.authorization) || res.token);
    if (hasAuth) return { auth: res, attempts: attempts };
    if (res && !partial) partial = res;
  }
  return { auth: partial, attempts: attempts };
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

async function fetchGradeFromPopup(grade, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ acdYearCode: String(grade) }),
      credentials: 'include',
      signal: ctrl.signal
    });
  } finally { clearTimeout(t); }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('غير مصرح (401/403). اضغط F5 على صفحة EMIS وسجّل الدخول ثم أعد المحاولة. ' + txt.slice(0, 80));
    }
    throw new Error('HTTP ' + res.status + ': ' + txt.slice(0, 120));
  }
  let data;
  try { data = await res.json(); }
  catch (e) {
    const txt = await res.text().catch(() => '');
    throw new Error('استجابة غير JSON (ربما انتهاء الجلسة أو حماية الموقع): ' + (txt || String(e)).slice(0, 120));
  }
  if (!Array.isArray(data)) {
    throw new Error('استجابة غير متوقعة (ليست قائمة): ' + JSON.stringify(data).slice(0, 120));
  }
  return data;
}

// ---------- fallback: fetch INSIDE the page, stash result on window, poll sync ----------
// Runs in the page (MAIN world preferred): kicks off the fetch and stores the outcome
// on window.__emisExport. Nothing is returned to the popup — the popup polls for it
// with a SYNCHRONOUS injection, so no async-result can be lost.
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

async function injectWorld(tab, opts) {
  try {
    return await chrome.scripting.executeScript(Object.assign({ target: { tabId: tab.id }, world: 'MAIN' }, opts));
  } catch (e) {
    return await chrome.scripting.executeScript(Object.assign({ target: { tabId: tab.id } }, opts));
  }
}

async function fetchGradeViaPage(tab, grade, headers) {
  try {
    await injectWorld(tab, { func: pageFetchStash, args: [grade, headers] });
  } catch (e) {
    throw new Error('تعذر تشغيل الجلب من داخل الصفحة: ' + String((e && e.message) || e).slice(0, 120));
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    if (cancelled) throw new Error('تم الإلغاء');
    await new Promise(r => setTimeout(r, 400));
    let st = null;
    try {
      const r = await injectWorld(tab, { func: pageFetchPoll, args: [grade] });
      st = (r && r[0] && r[0].result) || null;
    } catch (e) {
      throw new Error('تعذر قراءة نتيجة الصفحة: ' + String((e && e.message) || e).slice(0, 120));
    }
    if (st && st.done) {
      if (st.ok) return st.rows;
      throw new Error('HTTP ' + st.status + ' (عبر الصفحة): ' + String(st.err || '').slice(0, 140));
    }
  }
  throw new Error('انتهت مهلة الجلب من الصفحة للصف ' + grade);
}

async function fetchOneGrade(tab, g, headers) {
  try {
    return { rows: await fetchGradeFromPopup(g, headers), via: 'popup' };
  } catch (e1) {
    const m = String((e1 && e1.message) || e1);
    if (cancelled) throw e1;
    // Retry from inside the page (page origin + its own cookies) on anything that
    // looks like an HTTP rejection or a network-level failure from the popup origin.
    if (/401|403|4\d\d|5\d\d|Failed to fetch|NetworkError/i.test(m)) {
      try {
        return { rows: await fetchGradeViaPage(tab, g, headers), via: 'page' };
      } catch (e2) {
        throw new Error(m + ' | عبر الصفحة: ' + String((e2 && e2.message) || e2).slice(0, 140));
      }
    }
    throw e1;
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

// ---------- main export ----------
async function runExport(retryOnly) {
  const exportBtn = document.getElementById('exportBtn');
  const retryBtn = document.getElementById('retryBtn');
  const sortMode = document.getElementById('sort').value;
  const refYear = new Date().getFullYear(); // السن في 1/10 — always the current year
  const baseName = 'ابتدائي-كل-الفصول';

  let grades = retryOnly && lastFailedGrades.length ? lastFailedGrades.slice() : selectedGrades();
  if (!grades.length) { setStatus('اختر صفاً واحداً على الأقل'); return; }
  if (retryOnly && !lastFailedGrades.length) { setStatus('لا توجد صفوف فاشلة لإعادة محاولتها'); return; }

  cancelled = false;
  exportBtn.disabled = true;
  setFormEnabled(false);
  retryBtn.style.display = 'none';
  setCounts('');
  setProgress(0, grades.length);

  try {
    const tabQ = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = Array.isArray(tabQ) ? tabQ[0] : null;
    if (!tab || tab.id == null) throw new Error('تعذر تحديد التبويب النشط');
    const url = tab.url || '';
    // Only work on the EMIS student portal tab (matches host_permissions)
    if (!/^https:\/\/student\.emis\.gov\.eg\//.test(url)) {
      setStatus('⛔ افتح موقع student.emis.gov.eg وسجّل الدخول أولاً — لن أعمل على هذا التبويب لأسباب أمنية');
      return;
    }
    setStatus('قراءة بيانات الدخول من صفحة EMIS...');

    // Sync injection: read the app's captured headers + token/schoolcode from the page.
    const read = await readPageAuth(tab);
    const a = read.auth;
    const authSrc = a ? ((a.captured && a.captured.authorization) ? 'cap' : (a.token ? 'scan' : 'no')) : 'no';
    if (!a || authSrc === 'no') {
      const injectFailed = read.attempts.some(s => s.indexOf('ERR') !== -1);
      setStatus('⛔ لم أعثر على رمز الدخول (token) في صفحة EMIS — سجّل الدخول ثم اضغط F5 وأعد المحاولة');
      setCounts(
        'الخطوات:\n' +
        '1) افتح student.emis.gov.eg وسجّل الدخول\n' +
        '2) اضغط F5 على الصفحة\n' +
        '3) افتح الإضافة واضغط تنزيل\n' +
        (injectFailed ? 'تعذر الوصول للصفحة (صلاحيات) — أعد تحميل الإضافة من chrome://extensions ثم حدّث الصفحة\n' : '') +
        '[' + read.attempts.join(' | ') + ']'
      );
      return;
    }
    const headers = buildApiHeaders(a);
    const scSrc = headers.Schoolcode ? ((a.captured && a.captured.schoolcode) ? 'cap' : 'scan') : 'no';
    let captureHint = '';
    if (!a.captured) {
      captureHint = ' (ولم تُلتقط ترويسات الموقع — اضغط F5 على صفحة EMIS ثم أعد المحاولة)';
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['headerHook.js'] }); } catch (e) {}
    }
    if (!headers.Schoolcode) {
      setStatus('⚠ Schoolcode غير موجود — سأحاول، لكن إن فشل التحميل اضغط F5 على صفحة EMIS ثم أعد المحاولة');
    }
    if (cancelled) return;
    // On fresh export clear cache; on retry keep prior successes so we MERGE
    if (!retryOnly) cachedSuccess.clear();

    const perGrade = [];
    const failed = [];
    let done = 0;
    for (const g of grades) {
      if (cancelled) { setStatus('تم الإلغاء'); break; }
      setStatus('جاري تحميل الصف ' + GRADE_NAMES[g] + ' (' + (done + 1) + '/' + grades.length + ')... أبقِ النافذة مفتوحة');
      try {
        const r = await fetchOneGrade(tab, g, headers);
        const tagged = (r.rows || []).map(s => Object.assign({ _grade: g }, s));
        perGrade.push({ grade: g, rows: tagged, dbg: 'http=200 via=' + r.via + ' auth=' + authSrc + ' sc=' + scSrc });
        cachedSuccess.set(g, tagged);
      } catch (e) {
        failed.push(g);
        perGrade.push({ grade: g, rows: [], error: String((e && e.message) || e) });
      }
      done++;
      setProgress(done, grades.length);
    }
    if (cancelled) return;

    lastFailedGrades = failed.slice();
    // MERGE: cached successes from prior run + fresh results (retry no longer discards)
    const merged = new Map(cachedSuccess);
    for (const p of perGrade) { if (!p.error) merged.set(p.grade, p.rows); }
    const okGrades = Array.from(merged.entries()).map(([grade, rows]) => ({ grade: grade, rows: rows }));
    const allRows = sortStudents(okGrades.flatMap(p => p.rows), sortMode);

    const lines = perGrade.map(p => {
      if (p.error) return GRADE_NAMES[p.grade] + ': فشل — ' + p.error.slice(0, 160);
      const warn = p.rows.length === 0 ? ' ⚠' : '';
      return GRADE_NAMES[p.grade] + ': ' + p.rows.length + ' تلميذ' + warn + (p.dbg ? ' [' + p.dbg + ']' : '');
    });
    setCounts(lines.join('\n') + '\nالإجمالي: ' + allRows.length);

    if (!allRows.length) {
      setStatus('لا توجد بيانات. ' + (failed.length ? 'فشل: ' + failed.map(g => GRADE_NAMES[g]).join('، ') : 'تحقق من تسجيل الدخول أو حدّث الصفحة (F5).') + captureHint);
      if (failed.length) retryBtn.style.display = 'block';
      return;
    }

    setStatus('جاري إنشاء ملف Excel...');
    const bytes = buildXlsx(allRows, refYear);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const blobUrl = URL.createObjectURL(blob);
    // readable local timestamp, no spaces: ابتدائي-كل-الفصول-2026-09-25-20-36.xlsx
    // (":" and " " are avoided — Windows forbids ":", spaces are ugly in filenames)
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '-' + p2(d.getHours()) + '-' + p2(d.getMinutes());
    const filename = baseName + '-' + stamp + '.xlsx';

    try {
      // Anchor with the download attribute names blob downloads reliably;
      // chrome.downloads + blob: URLs can fall back to the blob's UUID as the name.
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      if (chrome.downloads && chrome.downloads.download) {
        await chrome.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: 'uniquify' });
        await new Promise(r => setTimeout(r, 800));
      } else {
        URL.revokeObjectURL(blobUrl);
        throw e;
      }
    }
    URL.revokeObjectURL(blobUrl);

    if (failed.length) {
      setStatus('✔ تم تنزيل ' + allRows.length + ' تلميذ — لكن فشل: ' + failed.map(g => GRADE_NAMES[g]).join('، '));
      retryBtn.style.display = 'block';
    } else {
      setStatus('✔ تم التنزيل: ' + allRows.length + ' تلميذ في ملف واحد');
    }
  } catch (e) {
    setStatus('خطأ: ' + (e.message || e));
  } finally {
    exportBtn.disabled = false;
    setFormEnabled(true);
    setProgress(0, 0);
  }
}

// ---------- XLSX builder (store-only ZIP, no external libs) ----------
// Layout matches the v1 file minus the unused "عمود 7" column: 15 cols A..O,
// 2 header rows, formulas H..O derived from the national ID in $C.
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Birth-date + age values, replicating EXACTLY what the I..P formulas compute from the
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

  const ssXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + (rows.length * 8 + 30) + '" uniqueCount="' + strings.length + '">' +
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
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>StudentDataExporter v2.10</Application></Properties>';

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
try { if (typeof module !== 'undefined') { module.exports = { sortStudents, buildXlsx, GRADE_NAMES, collectAuthInPage, buildApiHeaders, normalizeSchoolcode, pageFetchStash, pageFetchPoll, calcBirthValues }; } } catch (e) {}
