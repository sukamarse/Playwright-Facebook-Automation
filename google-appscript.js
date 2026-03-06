/**
 * FB Automation – Google Apps Script
 * 
 *  ✅ Chỉ đọc cột A (không getDataRange toàn sheet)
 *  ✅ Nhận report từ bot → ghi timestamp lên sheet tương ứng ô I1
 *  ✅ Tách action=getData vs action=report
 */

// ─────────────────────────────────────────────
//  doGet – entry point duy nhất
// ─────────────────────────────────────────────
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'getData';

  if (action === 'report') return handleReport(e.parameter);
  if (action === 'fail')   return handleFail(e.parameter);

  return handleGetData();
}

// ─────────────────────────────────────────────
//  handleGetData – trả về links + comments
// ─────────────────────────────────────────────
function handleGetData() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();

  var data = { comments: [], profiles: {} };

  for (var i = 0; i < sheets.length; i++) {
    var sheet     = sheets[i];
    var sheetName = sheet.getName();

    // Bỏ qua sheet tên bắt đầu bằng _ (sheet ẩn/config)
    if (sheetName.startsWith('_')) continue;

    var lastRow = sheet.getLastRow();
    if (lastRow === 0) continue;

    // Chỉ đọc cột A – nhanh hơn getDataRange() rất nhiều
    var values = sheet.getRange(1, 1, lastRow, 1).getValues();

    if (sheetName.toLowerCase() === 'comments') {
      for (var r = 0; r < values.length; r++) {
        var cell = values[r][0];
        if (cell && cell.toString().trim()) {
          data.comments.push(cell.toString().trim());
        }
      }
    } else {
      data.profiles[sheetName] = [];
      for (var r = 0; r < values.length; r++) {
        var cell = values[r][0];
        if (cell && cell.toString().trim()) {
          data.profiles[sheetName].push(cell.toString().trim());
        }
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────
//  handleFail – nhận fail signal từ bot, ghi FAIL vào cột B
//  Params: profile=<tên>, link=<url>
// ─────────────────────────────────────────────
function handleFail(params) {
  var profileName = params && params.profile ? params.profile : '';
  var link        = params && params.link    ? params.link    : '';

  if (!profileName || !link) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'missing params' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(profileName);

    if (!sheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'sheet not found' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var lastRow = sheet.getLastRow();
    if (lastRow === 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'empty sheet' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Tìm link trong cột A
    var colA = sheet.getRange(1, 1, lastRow, 1).getValues();
    for (var r = 0; r < colA.length; r++) {
      if (colA[r][0] && colA[r][0].toString().trim() === link.trim()) {
        sheet.getRange(r + 1, 2).setValue('FAIL'); // cột B
        return ContentService
          .createTextOutput(JSON.stringify({ ok: true, row: r + 1 }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'link not found in sheet' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (e) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: e.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─────────────────────────────────────────────
//  handleReport – nhận ping từ bot, ghi I1
//  Params: profile=<tên>, ts=<timestamp string>
// ─────────────────────────────────────────────
function handleReport(params) {
  var profileName = params && params.profile ? params.profile : '';
  var ts          = params && params.ts      ? params.ts      : new Date().toLocaleString();

  if (!profileName) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'missing profile' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(profileName);

    if (sheet) {
      // Ghi timestamp vào ô I1
      sheet.getRange('I1').setValue('🕐 Last successful fetch: ' + ts);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: e.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}