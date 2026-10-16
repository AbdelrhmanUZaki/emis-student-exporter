/* StudentDataExporter v3.7 - background service worker.
 * Runs the whole export (auth read -> API fetch per grade -> XLSX build -> download)
 * so it keeps going even if the popup is closed. Progress is persisted to
 * chrome.storage.session under 'exportState'; a reopened popup shows it live.
 * v3.7: stage-aware — the account stage (ابتدائي/إعدادي/حضانة) is detected from the
 *       site's own Schoolstage header or the "المرحلة" page label; grades beyond the
 *       stage are dropped automatically and names/file reflect the stage.
 * v3.4: fail-fast pre-flight — an expired session (401/403) is reported right after
 *       clicking download, not after every grade was tried.
 * v3.3: friendlier Arabic status wording; success message shows the saved filename.
 * v3.2: the file name reflects the selected grades (مرحلة-كل-الصفوف or
 *       مرحلة-صفوف-<numbers>); fresh exports clear the previous run's cache.
 */
'use strict';

if (typeof importScripts === 'function') { importScripts('shared.js'); }

const STATE_KEY = 'exportState';
const STAGE_INFO_KEY = 'stageInfo';

// File name — one rule for every case, all Arabic:
//   all grades of the stage -> ابتدائي-كل-الصفوف_<date>_<time>.xlsx
//   any partial selection   -> إعدادي-صفوف-1,3_<date>_<time>.xlsx
// Grade lists are ALWAYS comma-separated (no 1-3 ranges), so every '-'/'_' has
// exactly one meaning and the name/date boundary is always obvious.
// Unknown stage (legacy fallback): the stage word is simply omitted.
function fileBaseFor(gradesInFile, stage) {
  const uniq = Array.from(new Set(gradesInFile)).sort(function (a, b) { return a - b; });
  const stg = stage && STAGES[stage] ? STAGES[stage] : null;
  const all = stg ? stg.grades : [1, 2, 3, 4, 5, 6];
  const full = uniq.length === all.length && all.every(function (g, i) { return uniq[i] === g; });
  const body = full ? 'كل-الصفوف' : ('صفوف-' + uniq.join(','));
  return (stg ? stg.fileWord + '-' : '') + body;
}

// Account stage: the captured Schoolstage header wins (it drives the API),
// the "المرحلة" page label is the fallback; null = unknown (keep old behavior).
function resolveStage(a, pageStage) {
  const num = (a && ((a.captured && a.captured.schoolstage) || a.schoolstage)) || null;
  const byNum = stageFromSchoolstage(num);
  if (byNum) return byNum;
  if (pageStage && pageStage.stage) return pageStage.stage;
  return null;
}

// Diagnostics ([EMIS-TS] logs + the popup 🔍 line) are OFF for regular users.
// Hidden toggle: 5 quick clicks on the version number at the popup footer,
// or run chrome.storage.local.set({ emisDebug: true }) in the popup console.
async function isDebugOn() {
  try {
    const d = await chrome.storage.local.get('emisDebug');
    return !!(d && d.emisDebug);
  } catch (e) { return false; }
}

let st = { running: false, done: 0, total: 0, status: '', counts: '', lastFailed: [], cancelled: false, stage: null, ignoredGrades: 0 };
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
  st = { running: true, done: 0, total: grades.length, status: 'قراءة بيانات الدخول من صفحة EMIS...', counts: '', lastFailed: st.lastFailed || [], cancelled: false, stage: null, ignoredGrades: 0 };
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
    // Stage detection: the Schoolstage header captured from the site's own calls
    // wins (it drives the API), then the "المرحلة" label on the page. Unknown stage
    // keeps the old behavior (whatever the user selected, 1–6).
    const debug = await isDebugOn();
    let pageStage = null;
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: detectStageInPage, args: [debug] });
      pageStage = (r && r[0] && r[0].result) || null;
    } catch (e) {}
    st.stage = resolveStage(a, pageStage);
    const capStage = (a.captured && a.captured.schoolstage) || a.schoolstage || null;
    const stageSource = stageFromSchoolstage(capStage)
      ? 'Schoolstage=' + capStage
      : ((pageStage && pageStage.stage) ? (pageStage.source || 'page') : null);
    if (debug) { try { console.log('[EMIS-TS] export detection: captured schoolstage=' + capStage + ' | pageStage=' + JSON.stringify(pageStage) + ' => ' + st.stage + ' (' + (stageSource || 'unknown') + ')'); } catch (e) {} }
    try { chrome.storage.session.set({ [STAGE_INFO_KEY]: { stage: st.stage, source: stageSource, text: (pageStage && pageStage.text) || '', ts: Date.now() } }); } catch (e) {}
    // Drop grades that don't exist in this stage (e.g. 4–6 on إعدادي) — no junk requests.
    if (st.stage && STAGES[st.stage]) {
      const allowed = STAGES[st.stage].grades;
      const before = grades.length;
      grades = grades.filter(function (g) { return allowed.indexOf(g) !== -1; });
      st.ignoredGrades = before - grades.length;
      if (!grades.length) {
        await finish('⛔ لا صفوف صالحة لمرحلة «' + STAGES[st.stage].label + '» — أعد فتح النافذة واختر الصفوف من جديد');
        return;
      }
      if (st.ignoredGrades && debug) {
        try { console.log('[EMIS-TS] stage ' + st.stage + ': dropped ' + st.ignoredGrades + ' grade(s) outside the stage; keeping [' + grades.join(',') + ']'); } catch (e) {}
      }
      st.total = grades.length;
      save();
    }
    const nameOf = function (g) {
      const names = (st.stage && STAGES[st.stage] && STAGES[st.stage].names) || GRADE_NAMES;
      return names[g] || GRADE_NAMES[g] || ('صف ' + g);
    };
    const headers = buildApiHeaders(a, st.stage);
    if (!a.captured) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['headerHook.js'] }); } catch (e) {}
    }
    if (st.cancelled) { await finish('تم الإلغاء'); return; }

    const perGrade = [];
    const failed = [];
    let done = 0;
    let preferPage = false;

    // Pre-flight on the FIRST selected grade: auth problems (401/403) must surface
    // immediately, not after every grade was tried. If the extension-origin request
    // is rejected but the page-origin one works, prefer the page for the rest.
    const first = grades[0];
    st.status = 'جاري تحميل ' + nameOf(first) + ' (1 من ' + grades.length + ')...';
    save();
    let firstRows = null;
    let firstError = null;
    try {
      firstRows = await fetchGrade(tab.id, first, headers);
    } catch (e1) {
      const m1 = String((e1 && e1.message) || e1);
      if (!st.cancelled && /401|403|4\d\d|5\d\d|Failed to fetch|NetworkError/i.test(m1)) {
        try {
          firstRows = await fetchGradeViaPage(tab.id, first, headers);
          preferPage = true;
        } catch (e2) {
          firstError = m1 + ' | عبر الصفحة: ' + String((e2 && e2.message) || e2).slice(0, 140);
        }
      } else {
        firstError = m1;
      }
    }
    if (st.cancelled) { st.lastFailed = grades.slice(); await finish('تم الإلغاء'); return; }
    if (firstError) {
      // fail fast: show the problem right away, don't try the remaining grades
      st.lastFailed = grades.slice();
      if (/401|403/.test(firstError)) {
        st.status = '⛔ انتهت جلسة الدخول أو الصلاحية غير كافية — حدّث صفحة المدرسة (F5) وسجّل الدخول ثم أعد المحاولة';
        st.counts = 'الخطوات:\n1) اضغط F5 على صفحة student.emis.gov.eg\n2) سجّل الدخول من جديد\n3) افتح الإضافة واضغط تنزيل مرة أخرى\n[' + firstError.slice(0, 100) + ']';
      } else {
        st.status = '⛔ توقف التنزيل من أول خطوة: ' + firstError.slice(0, 140);
      }
      await finish();
      return;
    }
    const taggedFirst = firstRows.map(function (s) { return Object.assign({ _grade: first }, s); });
    perGrade.push({ grade: first, rows: taggedFirst });
    cachedSuccess.set(first, taggedFirst);
    done++;
    st.done = done;
    save();

    for (const g of grades.slice(1)) {
      if (st.cancelled) break;
      st.status = 'جاري تحميل ' + nameOf(g) + ' (' + (done + 1) + ' من ' + grades.length + ')...';
      save();
      try {
        const r = preferPage
          ? { rows: await fetchGradeViaPage(tab.id, g, headers), via: 'page' }
          : await fetchOneGrade(tab.id, g, headers);
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
      if (p.error) return nameOf(p.grade) + ': فشل — ' + String(p.error).slice(0, 140);
      return nameOf(p.grade) + ': ' + p.rows.length + ' تلميذ' + (p.rows.length === 0 ? ' ⚠' : '');
    });
    const stageHead = st.stage && STAGES[st.stage]
      ? 'المرحلة: ' + STAGES[st.stage].label + (st.ignoredGrades ? ' (تم تجاهل ' + st.ignoredGrades + ' صفوف خارج المرحلة)' : '') + '\n'
      : '';
    st.counts = stageHead + lines.join('\n') + '\nالإجمالي: ' + allRows.length;

    if (!allRows.length) {
      await finish('لا توجد بيانات. ' + (failed.length
        ? 'فشل: ' + failed.map(function (g) { return nameOf(g); }).join('، ')
        : (st.stage === 'kg'
          ? 'مرحلة رياض الأطفال (KG) جديدة وقد تحتاج ضبطاً — أبلغ مطوّر الأداة.'
          : 'تحقق من تسجيل الدخول أو حدّث الصفحة (F5).')));
      return;
    }

    st.status = 'جاري إنشاء ملف Excel...';
    save();
    const bytes = buildXlsx(allRows, refYear, st.stage);
    const p2 = function (n) { return String(n).padStart(2, '0'); };
    const d = new Date();
    const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '_' + p2(d.getHours()) + '-' + p2(d.getMinutes());
    const gradesInFile = Array.from(new Set(allRows.map(function (r) { return r._grade; })));
    const filename = fileBaseFor(gradesInFile, st.stage) + '_' + stamp + '.xlsx';
    await saveFile(bytes, filename);
    // tell the teacher exactly which file to look for in the Downloads folder
    st.counts += '\n📁 اسم الملف: ' + filename;

    await finish(failed.length
      ? '✔ اكتمل التنزيل — ' + allRows.length + ' تلميذ، لكن فشل: ' + failed.map(function (g) { return nameOf(g); }).join('، ')
      : '✔ اكتمل التنزيل بنجاح! ' + allRows.length + ' تلميذ في ملف واحد');
  } catch (e) {
    await finish('خطأ: ' + ((e && e.message) || e));
  }
}

// Live detection for the popup: reads the captured Schoolstage header and the
// "المرحلة" page label on the ACTIVE tab. Never throws; { ok:false } when the
// active tab isn't an EMIS page.
async function detectStageInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null || !/^https:\/\/student\.emis\.gov\.eg\//.test(tab.url || '')) {
    return { ok: false, reason: 'not-emis', stage: null };
  }
  const debug = await isDebugOn();
  let num = null;
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readCapturedStage, args: [debug] });
    num = (r && r[0] && r[0].result) || null;
  } catch (e) {}
  let page = null;
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: detectStageInPage, args: [debug] });
    page = (r && r[0] && r[0].result) || null;
  } catch (e) {}
  const byNum = stageFromSchoolstage(num);
  const stage = byNum || (page && page.stage) || null;
  const info = { stage: stage, source: byNum ? 'Schoolstage=' + num : ((page && page.source) || null), text: (page && page.text) || '', ts: Date.now() };
  if (debug) { try { console.log('[EMIS-TS] popup detection: schoolstage=' + num + ' | page=' + JSON.stringify(page ? { stage: page.stage, source: page.source, text: page.text } : null) + ' => ' + stage + ' (' + info.source + ')'); } catch (e) {} }
  try { chrome.storage.session.set({ [STAGE_INFO_KEY]: info }); } catch (e) {}
  return { ok: true, stage: stage, source: info.source, text: info.text };
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
    } else if (msg.type === 'detect') {
      detectStageInTab().then(function (res) { sendResponse(res); }).catch(function (e) { sendResponse({ ok: false, error: String(e), stage: null }); });
      return true; // keep the channel open for the async reply
    } else sendResponse({ ok: false });
  } catch (e) {
    try { sendResponse({ ok: false, error: String(e) }); } catch (e2) {}
  }
  return false;
});

// expose for testing in Node (ignored in browser)
try { if (typeof module !== 'undefined') { module.exports = { fileBaseFor, resolveStage }; } } catch (e) {}
