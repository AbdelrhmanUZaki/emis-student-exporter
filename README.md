# EMIS Student Exporter — أداة تصدير بيانات الطلاب

Chrome extension (Manifest V3) that exports **all students of a school to a single Excel file in one click**, using the logged-in session of [student.emis.gov.eg](https://student.emis.gov.eg/). **Stage-aware:** it detects the account's stage (ابتدائي / إعدادي / رياض أطفال) and shows only that stage's grades.

أداة كروم لتصدير كل تلاميذ المدرسة في ملف إكسل واحد بضغطة زر واحدة — وتتعرف تلقائياً على المرحلة (ابتدائي / إعدادي / رياض أطفال) وتعرض صفوف المرحلة فقط.

## Install / التثبيت

1. Download this folder (or `git clone` it).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open `student.emis.gov.eg` and log in, then press **F5** once so the extension can capture the site's request headers.

## Usage / الاستخدام

1. Open the EMIS student portal and log in.
2. Click the extension icon — the popup shows the detected stage (ابتدائي / إعدادي / حضانة) with that stage's grades only (KG: KG1–KG2, إعدادي: 1–3, ابتدائي: 1–6). If the stage can't be detected, all six grades are shown as before.
3. Pick the grades (default: all), choose the ordering, and press **⬇ تنزيل ملف الإكسل**.
4. The file name reflects the stage and the grades actually in the file — all Arabic, one rule `مرحلة-المحتوى_التاريخ_الوقت.xlsx` (local timestamp):
   - All grades of the stage: `ابتدائي-كل-الصفوف_2026-10-16_22-15.xlsx` (same for `إعدادي-...` / `حضانة-...`)
   - Any partial selection: `إعدادي-صفوف-1,3_2026-10-16_22-15.xlsx` — grade numbers are always a comma-separated list (no `1-3` ranges)
   - Unknown stage: the stage word is omitted (`كل-الصفوف_...` / `صفوف-1,3_...`)
5. You can close the popup while it downloads — the export runs in a background
   service worker and the file is saved automatically. Reopen the popup any time
   to see progress or the final result. If the EMIS session has expired (401/403),
   the export stops immediately with instructions instead of failing grade by grade.

## What's in the file

- One sheet, RTL, 15 columns (A–O): student code, name, national ID, grade, class, gender, plus birth date and age at 1/10 of the **current year** derived from the national ID (values are pre-computed so they show in any spreadsheet app, with the original formulas kept for Excel).
- Rows are colored by gender: **boys = sky blue, girls = pink**.
- Ordering options: **البنين قبل البنات (أبجدي)** or **البنات قبل البنين (أبجدي)** —
  alphabetical within each gender group, class by class.

## How it works

- **Stage detection:** the account stage is read from the site's own `Schoolstage` request header (1=حضانة/KG, 2=ابتدائي, 3=إعدادي — verified live on all three portals) — captured by the extension from the portal's API calls — with a fallback to the "المرحلة: ..." label shown on the page (supports ابتدائي/ابتدائى، إعدادي/اعدادى، رياض اطفال/حضانة). Unknown stage = classic 1–6 behavior, nothing breaks.
- Grades beyond the detected stage are dropped automatically (e.g. ticking 4–6 on an إعدادي account sends no junk requests) and the progress lines say so.
- Reads the auth material (Bearer token, `Schoolcode`, `Schoolstage`, `Usertype`) from the open EMIS page — nothing is copy-pasted by hand.
- Calls `https://studaapi.emis.gov.eg/api/Student/GetSchoolStudent` per grade (`{"acdYearCode":"1".."6"}`) and merges the results.
- A pre-flight check on the first selected grade surfaces expired-session errors (401/403) immediately, with F5/login instructions.
- Falls back to a page-context request automatically if the popup request is rejected.
- The file is saved through an offscreen page so the requested filename is always honored.
- **Diagnostics:** hidden for regular users — click the version number (`v3.7`) at the bottom of the popup **5 times** to toggle the diagnostic mode: a tiny 🔍 line then appears under the grades explaining WHY the stage was chosen (e.g. "schoolstage = 1" from the site header, or the page label it read), and every step is logged to the console with an `[EMIS-TS]` prefix (site page console, popup console, service-worker console). Click 5 more times to turn it off; the choice is saved and is off on a fresh install.

## Privacy

No data leaves your machine except the API calls the extension makes to EMIS itself, authenticated with **your own** logged-in session. No tokens are stored, logged, or sent anywhere else.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `popup.html` | Popup UI |
| `popup.js` | Popup controller (stage-aware grade list, sends commands, shows live progress) |
| `background.js` | Service worker: runs the whole export — survives closing the popup |
| `shared.js` | Shared logic: auth reading, stage detection, API fetch, sorting, XLSX builder (no libraries) |
| `offscreen.html` / `offscreen.js` | Saves the generated file with its proper filename (anchor download) |
| `headerHook.js` | Captures the site's own API request headers |

---
Based on the original work of مستر مصطفى عصمت — شكراً له.
