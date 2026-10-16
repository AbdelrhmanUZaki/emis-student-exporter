/* StudentDataExporter v3.7 popup — thin UI only.
 * The export runs in the background service worker and keeps going even if this
 * popup is closed. Progress lives in chrome.storage.session ('exportState') and
 * this popup renders it live via chrome.storage.onChanged.
 * v3.7: the grade list follows the account stage (ابتدائي 1–6 / إعدادي 1–3 /
 *       حضانة KG1–KG2) — detected live from the active EMIS tab, cached in
 *       session storage. Unknown stage falls back to the old six-grade list.
 *       Diagnostics (the 🔍 source line + [EMIS-TS] logs) are OFF for regular
 *       users; enable them with 5 quick clicks on the version number (v3.7).
 */
'use strict';

const STATE_KEY = 'exportState';
const STAGE_KEY = 'stageInfo';
let currentStage = null;      // 'primary' | 'prep' | 'kg' | null (unknown)
let currentGrades = [1, 2, 3, 4, 5, 6];
let isRunning = false;
let lastEvidence = null;      // { stage, source, text } from the last detection
let debugOn = false;          // hidden diagnostics switch (5 clicks on v3.7)

function $(id) { return document.getElementById(id); }
function dlog() {
  if (!debugOn) return;
  try { console.log.apply(console, arguments); } catch (e) {}
}
function setStatus(t) { $('status').textContent = t || ''; }
function setCounts(t) { $('counts').textContent = t || ''; }
function setProgress(done, total) {
  const bar = $('progress'), fill = $('progressBar');
  if (!total || !done) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  fill.style.width = Math.round((done / total) * 100) + '%';
}
function gradeListFor(stage) {
  return (stage && STAGES[stage]) ? STAGES[stage].grades.slice() : [1, 2, 3, 4, 5, 6];
}
function gradeLabel(stage, g) {
  const names = (stage && STAGES[stage] && STAGES[stage].names) || null;
  return (names && names[g]) || GRADE_NAMES[g] || String(g);
}
function updateStageTag(mode) {
  const el = $('stageTag');
  if (!el) return;
  if (currentStage && STAGES[currentStage]) { el.textContent = '(المرحلة: ' + STAGES[currentStage].label + ')'; return; }
  if (mode === 'off') el.textContent = '(افتح صفحة المدرسة وسجّل الدخول)';
  else if (mode === 'unknown') el.textContent = '(لم أتعرف على المرحلة — سجّل الدخول واضغط F5)';
  else el.textContent = '(جاري التعرف على المرحلة...)';
}
// human-friendly one-liner that explains WHERE the stage came from
function evidenceText(stage, source, text) {
  if (!stage || !source) return '';
  source = String(source);
  if (source.indexOf('Schoolstage=') === 0) return '🔍 اتعرفت من هيدر الموقع: schoolstage = ' + source.slice('Schoolstage='.length);
  if (source === 'label') return '🔍 اتعرفت من اللافتة: «' + String(text || '').trim() + '»';
  if (source === 'body') return '🔍 اتعرفت من نص الصفحة: «' + String(text || '').trim() + '»';
  if (source === 'url') return '🔍 اتعرفت من رابط الصفحة (kg)';
  if (source === 'page') return '🔍 اتعرفت من محتوى الصفحة';
  if (source === 'export') return '🔍 اتعرفت أثناء آخر تنزيل';
  return '🔍 المصدر: ' + source;
}
function adoptEvidence() {
  const el = $('detectNote');
  if (!el) return;
  el.textContent = (debugOn && lastEvidence && lastEvidence.stage && lastEvidence.stage === currentStage)
    ? evidenceText(lastEvidence.stage, lastEvidence.source, lastEvidence.text)
    : '';
}
function renderGrades(stage) {
  currentStage = (stage && STAGES[stage]) ? stage : null;
  currentGrades = gradeListFor(currentStage);
  const box = $('gradesBox');
  box.textContent = '';
  currentGrades.forEach(function (g) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'grade-' + g;
    cb.checked = true;
    cb.disabled = isRunning;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + gradeLabel(currentStage, g)));
    box.appendChild(lab);
  });
  updateStageTag();
  adoptEvidence();
}
function selectedGrades() {
  return currentGrades.filter(function (g) { const el = $('grade-' + g); return el && el.checked; });
}
function setFormEnabled(v) {
  currentGrades.forEach(function (g) { const el = $('grade-' + g); if (el) el.disabled = !v; });
  $('sort').disabled = !v;
  $('allBtn').disabled = !v;
  $('noneBtn').disabled = !v;
  $('exportBtn').disabled = !v;
  $('cancelBtn').style.display = v ? 'none' : 'block';
}
function render(st) {
  if (!st) return;
  setStatus(st.status);
  setCounts(st.counts);
  setProgress(st.running ? st.done : 0, st.running ? st.total : 0);
  isRunning = !!st.running;
  setFormEnabled(!st.running);
  $('retryBtn').style.display = (!st.running && st.lastFailed && st.lastFailed.length) ? 'block' : 'none';
}
function send(msg) {
  try { chrome.runtime.sendMessage(msg, function () {}); } catch (e) {}
}
function askDetect() {
  try {
    chrome.runtime.sendMessage({ type: 'detect' }, function (res) {
      dlog('[EMIS-TS] popup got detection reply:', res);
      if (chrome.runtime.lastError || !res) { updateStageTag(currentStage ? null : 'unknown'); return; }
      if (res.ok && res.stage) {
        lastEvidence = { stage: res.stage, source: res.source, text: res.text };
        if (res.stage !== currentStage) renderGrades(res.stage);
        else { updateStageTag(); adoptEvidence(); }
      } else if (!res.ok && res.reason === 'not-emis') {
        updateStageTag(currentStage ? null : 'off');
      } else {
        updateStageTag(currentStage ? null : 'unknown');
      }
    });
  } catch (e) {}
}

function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }
on('allBtn', 'click', function () { currentGrades.forEach(function (g) { const el = $('grade-' + g); if (el && !el.disabled) el.checked = true; }); });
on('noneBtn', 'click', function () { currentGrades.forEach(function (g) { const el = $('grade-' + g); if (el && !el.disabled) el.checked = false; }); });
on('exportBtn', 'click', function () {
  if (!selectedGrades().length) { setStatus('اختر صفاً واحداً على الأقل'); return; }
  setStatus('جاري التحضير...');
  setCounts('');
  isRunning = true;
  setFormEnabled(false);
  send({ type: 'start', grades: selectedGrades(), sort: $('sort').value });
});
on('retryBtn', 'click', function () {
  setStatus('جاري إعادة المحاولة...');
  send({ type: 'retry', sort: $('sort').value });
});
on('cancelBtn', 'click', function () { setStatus('جاري الإلغاء...'); send({ type: 'cancel' }); });

// show current/last state (also after reopening the popup mid- or post-export)
Promise.all([
  chrome.storage.session.get([STATE_KEY, STAGE_KEY]),
  chrome.storage.local.get('emisDebug')
]).then(function (res) {
  const d = res[0] || {};
  debugOn = !!(res[1] && res[1].emisDebug);
  render(d[STATE_KEY]);
  const cached = d[STAGE_KEY];
  dlog('[EMIS-TS] popup open, cached stageInfo:', cached);
  if (cached && cached.stage) lastEvidence = cached;
  renderGrades(cached && cached.stage ? cached.stage : null);
  askDetect();
}).catch(function () { renderGrades(null); askDetect(); });
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'session' && changes[STATE_KEY]) render(changes[STATE_KEY].newValue);
});

// Hidden diagnostics switch: 5 quick clicks on the version number toggle the
// 🔍 source line + [EMIS-TS] logs. OFF for regular users (stored in local).
let vClicks = 0, vTimer = null;
on('verTag', 'click', function () {
  vClicks++;
  clearTimeout(vTimer);
  vTimer = setTimeout(function () { vClicks = 0; }, 2500);
  if (vClicks < 5) return;
  vClicks = 0;
  debugOn = !debugOn;
  try { chrome.storage.local.set({ emisDebug: debugOn }); } catch (e) {}
  adoptEvidence();
  setStatus(debugOn
    ? '🔧 وضع التشخيص شغال — سطر 🔍 تحت الصفوف واللوجات [EMIS-TS] في الكونسول'
    : '✔ وضع التشخيص اتطفى');
});
