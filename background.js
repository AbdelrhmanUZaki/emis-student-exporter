/* StudentDataExporter v3.3 - background service worker.
 * Runs the whole export (auth read -> API fetch per grade -> XLSX build -> download)
 * so it keeps going even if the popup is closed. Progress is persisted to
 * chrome.storage.session under 'exportState'; a reopened popup shows it live.
 * v3.3: friendlier Arabic status wording; success message shows the saved filename.
 * v3.2: the file name reflects the selected grades (ابتدائي-كل-الفصول when all six,
 *       otherwise grades-<numbers>); fresh exports clear the previous run's cache.
 */
'use strict';

if (typeof importScripts === 'function') { importScripts('shared.js'); }

const STATE_KEY = 'exportState';

// File name reflects the grades actually in the file:
//   all six      -> ابتدائي-كل-الفصول-<timestamp>.xlsx
//   contiguous   -> grades-1,2,3,4-<timestamp>.xlsx   (listed number by number)
//   with gaps    -> grades-1,3-5-<timestamp>.xlsx      (runs of 3+ compress to a range)
function fileBaseFor(gradesInFile) {
  const uniq = Array.from(new Set(gradesInFile)).sort(function (a, b) { return a - b; });
  const all = [1, 2, 3, 4, 5, 6];
  if (uniq.length === all.length && all.every(function (g, i) { return uniq[i] === g; })) return 'ابتدائي-كل-الفصول';
  const contiguous = uniq.length > 0 && (uniq[uniq.length - 1] - uniq[0] + 1 === uniq.length);
  if (contiguous) return 'grades-' + uniq.join(',');
  const parts = [];
  let i = 0;
  while (i < uniq.length) {
    let j = i;
    while (j + 1 < uniq.length && uniq[j + 1] === uniq[j] + 1) j++;
    parts.push((j - i + 1) >= 3 ? uniq[i] + '-' + uniq[j] : uniq.slice(i, j + 1).join(','));
    i = j + 1;
  }
  return 'grades-' + parts.join(',');
}

let st = { running: false, done: 0, total: 0, status: '', counts: '', lastFailed: [], cancelled: false };
let cachedSuccess = new Map(); // grade -> rows (kept so retry merges with earlier successes)
let currentAbort = null;
let keepAlive = null;

function save() {
  try { chrome.storage.session.set({ [STATE_KEY]: JSON.parse(JSON.stringify(st)) }); } catch (e) {}
}

async function readPageAuth(tabId) {
  const attempts = [];
  let partial = null;
  for (const world of ['MAIN', 'ISOLATED']) {
    let res = null, err = null;
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId: tabId }, world: world, func: collectAuthInPage });
      res = (r && r[0] && r[0].result) || null;
    } catch (e) { err = String((e && e.message) || e); }
    attempts.push(world + '=' + (res ? 'ok' : 'ERR: ' + String(err || '').slice(0, 80)));
    const hasAuth = res && ((res.captured && res.captured.authorization) || res.token);
    if (hasAuth) return { auth: res, attempts: attempts };
    if (res && !partial) partial = res;
  }
  return { auth: partial, attempts: attempts };
}

async function fetchGrade(tabId, grade, headers) {
  const ctrl = new AbortController();
  currentAbort = ctrl;
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
  } finally { clearTimeout(t); currentAbort = null; }
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

// fallback: run the fetch inside the page (page origin + its own cookies), stash the
// result on window and poll it with SYNC injections (no async result can be lost).
async function fetchGradeViaPage(tabId, grade, headers) {
  try {
    await injectWorld(tabId, { func: pageFetchStash, args: [grade, headers] });
  } catch (e) {
    throw new Error('تعذر تشغيل الجلب من داخل الصفحة: ' + String((e && e.message) || e).slice(0, 120));
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    if (st.cancelled) throw new Error('تم الإلغاء');
    await new Promise(r => setTimeout(r, 400));
    let entry = null;
    try {
      const r = await injectWorld(tabId, { func: pageFetchPoll, args: [grade] });
      entry = (r && r[0] && r[0].result) || null;
    } catch (e) {
      throw new Error('تعذر قراءة نتيجة الصفحة: ' + String((e && e.message) || e).slice(0, 120));
    }
    if (entry && entry.done) {
      if (entry.ok) return entry.rows;
      throw new Error('HTTP ' + entry.status + ' (عبر الصفحة): ' + String(entry.err || '').slice(0, 140));
    }
  }
  throw new Error('انتهت مهلة الجلب من الصفحة للصف ' + grade);
}

async function injectWorld(tabId, opts) {
  try {
    return await chrome.scripting.executeScript(Object.assign({ target: { tabId: tabId }, world: 'MAIN' }, opts));
  } catch (e) {
    return await chrome.scripting.executeScript(Object.assign({ target: { tabId: tabId } }, opts));
  }
}

async function fetchOneGrade(tabId, g, headers) {
  try {
    return { rows: await fetchGrade(tabId, g, headers), via: 'popup' };
  } catch (e1) {
    const m = String((e1 && e1.message) || e1);
    if (st.cancelled) throw e1;
    // Retry from inside the page (page origin + its own cookies) on HTTP rejections
    // or network-level failures from the extension origin.
    if (/401|403|4\d\d|5\d\d|Failed to fetch|NetworkError/i.test(m)) {
      try {
        return { rows: await fetchGradeViaPage(tabId, g, headers), via: 'page' };
      } catch (e2) {
        throw new Error(m + ' | عبر الصفحة: ' + String((e2 && e2.message) || e2).slice(0, 140));
      }
    }
    throw e1;
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// Chrome names data-URL downloads "download" and ignores the filename, and the
// service worker has no DOM for anchor downloads. So the file is handed to an
// offscreen page which saves it via an anchor download (filename always honored).
const OFFSCREEN_URL = 'offscreen.html';
async function saveFile(bytes, filename) {
  const b64 = bytesToBase64(bytes);
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'حفظ ملف Excel المُنشأ بالاسم الصحيح'
    });
  } catch (e) { /* already exists — reuse it */ }
  const done = new Promise(function (resolve) {
    const listener = function (msg) {
      if (msg && msg.type === 'offscreen-download-done') {
        try { chrome.runtime.onMessage.removeListener(listener); } catch (e) {}
        resolve(true);
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    setTimeout(function () {
      try { chrome.runtime.onMessage.removeListener(listener); } catch (e) {}
      resolve(false);
    }, 15000);
  });
  try {
    chrome.runtime.sendMessage({ type: 'download-xlsx', filename: filename, b64: b64 }, function () { void chrome.runtime.lastError; });
  } catch (e) {
    try { await chrome.offscreen.closeDocument(); } catch (e2) {}
    throw e;
  }
  await done;
  try { await chrome.offscreen.closeDocument(); } catch (e) {}
}

async function startExport(retryOnly, gradesArg, sortMode) {
  if (st.running) return;
  let grades = retryOnly ? (st.lastFailed || []).slice() : (gradesArg || []).slice();
  if (!grades.length) {
    st.status = retryOnly ? 'لا توجد صفوف فاشلة لإعادة محاولتها' : 'اختر صفاً واحداً على الأقل';
    save();
    return;
  }
  const refYear = new Date().getFullYear(); // السن في 1/10 — always the current year
  if (!retryOnly) cachedSuccess.clear(); // fresh run: never leak grades from a previous run
  st = { running: true, done: 0, total: grades.length, status: 'قراءة بيانات الدخول من صفحة EMIS...', counts: '', lastFailed: st.lastFailed || [], cancelled: false };
  save();
  // keep the service worker alive while the export runs
  keepAlive = setInterval(function () { try { chrome.runtime.getPlatformInfo(function () {}); } catch (e) {} }, 20000);
  const finish = async (statusMsg) => {
    st.running = false;
    if (statusMsg) st.status = statusMsg;
    clearInterval(keepAlive);
    save();
  };
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) { await finish('خطأ: تعذر تحديد التبويب النشط'); return; }
    if (!/^https:\/\/student\.emis\.gov\.eg\//.test(tab.url || '')) {
      await finish('⛔ افتح موقع student.emis.gov.eg وسجّل الدخول أولاً — لن أعمل على هذا التبويب لأسباب أمنية');
      return;
    }
    const read = await readPageAuth(tab.id);
    const a = read.auth;
    if (!a || !((a.captured && a.captured.authorization) || a.token)) {
      const injectFailed = read.attempts.some(function (s) { return s.indexOf('ERR') !== -1; });
      st.status = '⛔ لم أعثر على رمز الدخول (token) في صفحة EMIS — سجّل الدخول ثم اضغط F5 وأعد المحاولة';
      st.counts = 'الخطوات:\n1) افتح student.emis.gov.eg وسجّل الدخول\n2) اضغط F5 على الصفحة\n3) افتح الإضافة واضغط تنزيل\n' +
        (injectFailed ? 'تعذر الوصول للصفحة (صلاحيات) — أعد تحميل الإضافة من chrome://extensions ثم حدّث الصفحة\n' : '') +
        '[' + read.attempts.join(' | ') + ']';
      await finish();
      return;
    }
    const headers = buildApiHeaders(a);
    if (!a.captured) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['headerHook.js'] }); } catch (e) {}
    }
    if (st.cancelled) { await finish('تم الإلغاء'); return; }

    const perGrade = [];
    const failed = [];
    let done = 0;
    for (const g of grades) {
      if (st.cancelled) break;
      st.status = 'جاري تحميل ' + GRADE_NAMES[g] + ' (' + (done + 1) + ' من ' + grades.length + ')...';
      save();
      try {
        const r = await fetchOneGrade(tab.id, g, headers);
        const tagged = (r.rows || []).map(function (s) { return Object.assign({ _grade: g }, s); });
        perGrade.push({ grade: g, rows: tagged });
        cachedSuccess.set(g, tagged);
      } catch (e) {
        failed.push(g);
        perGrade.push({ grade: g, rows: [], error: String((e && e.message) || e) });
      }
      done++;
      st.done = done;
      save();
    }
    if (st.cancelled) { st.lastFailed = failed; await finish('تم الإلغاء'); return; }
    st.lastFailed = failed.slice();

    // MERGE: cached successes from prior runs + fresh results (retry never discards)
    const merged = new Map(cachedSuccess);
    for (const p of perGrade) { if (!p.error) merged.set(p.grade, p.rows); }
    const okGrades = Array.from(merged.entries()).map(function (en) { return { grade: en[0], rows: en[1] }; });
    const allRows = sortStudents(okGrades.flatMap(function (p) { return p.rows; }), sortMode);

    // clean, non-technical progress lines
    const lines = perGrade.map(function (p) {
      if (p.error) return GRADE_NAMES[p.grade] + ': فشل — ' + String(p.error).slice(0, 140);
      return GRADE_NAMES[p.grade] + ': ' + p.rows.length + ' تلميذ' + (p.rows.length === 0 ? ' ⚠' : '');
    });
    st.counts = lines.join('\n') + '\nالإجمالي: ' + allRows.length;

    if (!allRows.length) {
      await finish('لا توجد بيانات. ' + (failed.length ? 'فشل: ' + failed.map(function (g) { return GRADE_NAMES[g]; }).join('، ') : 'تحقق من تسجيل الدخول أو حدّث الصفحة (F5).'));
      return;
    }

    st.status = 'جاري إنشاء ملف Excel...';
    save();
    const bytes = buildXlsx(allRows, refYear);
    const p2 = function (n) { return String(n).padStart(2, '0'); };
    const d = new Date();
    const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '-' + p2(d.getHours()) + '-' + p2(d.getMinutes());
    const gradesInFile = Array.from(new Set(allRows.map(function (r) { return r._grade; })));
    const filename = fileBaseFor(gradesInFile) + '-' + stamp + '.xlsx';
    await saveFile(bytes, filename);
    // tell the teacher exactly which file to look for in the Downloads folder
    st.counts += '\n📁 اسم الملف: ' + filename;

    await finish(failed.length
      ? '✔ اكتمل التنزيل — ' + allRows.length + ' تلميذ، لكن فشل: ' + failed.map(function (g) { return GRADE_NAMES[g]; }).join('، ')
      : '✔ اكتمل التنزيل بنجاح! ' + allRows.length + ' تلميذ في ملف واحد');
  } catch (e) {
    await finish('خطأ: ' + ((e && e.message) || e));
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  try {
    if (msg.type === 'start') { startExport(false, msg.grades, msg.sort); sendResponse({ ok: true }); }
    else if (msg.type === 'retry') { startExport(true, null, msg.sort); sendResponse({ ok: true }); }
    else if (msg.type === 'cancel') {
      st.cancelled = true;
      if (currentAbort) { try { currentAbort.abort(); } catch (e) {} }
      save();
      sendResponse({ ok: true });
    } else sendResponse({ ok: false });
  } catch (e) {
    try { sendResponse({ ok: false, error: String(e) }); } catch (e2) {}
  }
  return false;
});

// expose for testing in Node (ignored in browser)
try { if (typeof module !== 'undefined') { module.exports = { fileBaseFor }; } } catch (e) {}
