# EMIS Student Exporter — أداة تصدير بيانات الطلاب

Chrome extension (Manifest V3) that exports **all students of a school (grades 1–6) to a single Excel file in one click**, using the logged-in session of [student.emis.gov.eg](https://student.emis.gov.eg/).

أداة كروم لتصدير كل تلاميذ المدرسة (من الصف الأول للسادس) في ملف إكسل واحد بضغطة زر واحدة.

## Install / التثبيت

1. Download this folder (or `git clone` it).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open `student.emis.gov.eg` and log in, then press **F5** once so the extension can capture the site's request headers.

## Usage / الاستخدام

1. Open the EMIS student portal and log in.
2. Click the extension icon.
3. Pick the grades (default: all), choose the ordering, and press **⬇ تنزيل ملف Excel**.
4. The file is saved as `ابتدائي-كل-الفصول-<YYYY-MM-DD-HH-MM>.xlsx` (local timestamp).
5. You can close the popup while it downloads — the export runs in a background
   service worker and the file is saved automatically. Reopen the popup any time
   to see progress or the final result.

## What's in the file

- One sheet, RTL, 15 columns (A–O): student code, name, national ID, grade, class, gender, plus birth date and age at 1/10 of the **current year** derived from the national ID (values are pre-computed so they show in any spreadsheet app, with the original formulas kept for Excel).
- Rows are colored by gender: **boys = sky blue, girls = pink**.
- Boys-first / girls-first / alphabetical ordering per grade.

## How it works

- Reads the auth material (Bearer token, `Schoolcode`, `Schoolstage`, `Usertype`) from the open EMIS page — nothing is copy-pasted by hand.
- Calls `https://studaapi.emis.gov.eg/api/Student/GetSchoolStudent` per grade (`{"acdYearCode":"1".."6"}`) and merges the results.
- Falls back to a page-context request automatically if the popup request is rejected.

## Privacy

No data leaves your machine except the API calls the extension makes to EMIS itself, authenticated with **your own** logged-in session. No tokens are stored, logged, or sent anywhere else.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `popup.html` | Popup UI |
| `popup.js` | Popup controller (sends commands, shows live progress) |
| `background.js` | Service worker: runs the whole export — survives closing the popup |
| `shared.js` | Shared logic: auth reading, API fetch, sorting, XLSX builder (no libraries) |
| `offscreen.html` / `offscreen.js` | Saves the generated file with its proper filename (anchor download) |
| `headerHook.js` | Captures the site's own API request headers |

---
Based on the original work of مستر مصطفى عصمت — شكراً له.
