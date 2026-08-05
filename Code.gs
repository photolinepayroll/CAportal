function doGet(e) {
  ensureRequestHeaders_();
  getRolesSheet_();
  getMasterlistSheet_();
  getSettingsSheet_();
  var isAdmin = e && e.parameter && e.parameter.page === 'admin';
  return HtmlService.createHtmlOutputFromFile(isAdmin ? 'Admin' : 'Employee')
    .setTitle(isAdmin ? 'Photoline CA Portal — Staff' : 'Photoline Cash Advance Ledger')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * RPC bridge used only when the frontend is opened as a local file instead of being served
 * by Apps Script (google.script.run isn't available there). Body: {fn: 'functionName', args: [...]}.
 * Whitelisted so a local preview page can only ever call the same functions google.script.run exposes.
 */
function doPost(e) {
  var whitelist = {
    login: login,
    createRequest: createRequest,
    getRequestByLastNameAndId: getRequestByLastNameAndId,
    getPendingForProcessor: getPendingForProcessor,
    getPendingForApprover: getPendingForApprover,
    generateHrSummary: generateHrSummary,
    processorReview: processorReview,
    approverReview: approverReview,
    processorReviewBatch: processorReviewBatch,
    approverReviewBatch: approverReviewBatch,
    getCaWindowStatus: getCaWindowStatus,
    setCaWindowOverride: setCaWindowOverride,
    verifyIdentity: verifyIdentity,
    getBranchList: getBranchList
  };
  var response;
  try {
    var body = JSON.parse(e.postData.contents);
    var fn = whitelist[body.fn];
    if (!fn) throw new Error('Unknown or disallowed function: ' + body.fn);
    var result = fn.apply(null, body.args || []);
    response = { success: true, result: result };
  } catch (err) {
    response = { success: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Single source of truth for the bound spreadsheet's structure.
 * If the sheet's columns or tab names ever change, this is the only place that needs editing.
 */

var SHEET_ID = '1QQHtB8mrvexMwLMgeSVRExgK0ohOHroDk4icfRbTdm0';
var REQUESTS_TAB = 'Form Responses 1';
var ROLES_TAB = 'Roles';
var MASTERLIST_TAB = 'Masterlist';
var SETTINGS_TAB = 'Settings';

// 1-based column indices for the Requests tab.
var COL = {
  TIMESTAMP: 1,
  BRANCH: 2,
  NAME: 3,
  AMOUNT: 4,
  AUTH_CODE: 5,   // legacy, unused by new logic
  WORKING_DAYS_LEGACY: 6, // legacy, unused by new logic
  REQUEST_ID: 7,
  PURPOSE: 8,
  DATE_NEEDED: 9,
  CUTOFF_PERIOD: 10,
  DAYS_PRESENT: 11,
  STATUS: 12,
  PROCESSOR_REMARKS: 13,
  ATD_COMPLIANCE: 14,
  APPROVER_REMARKS: 15,
  DATE_APPROVED: 16,
  FORWARDED_TO_HR: 17
};

var REQUEST_HEADERS = [
  'Timestamp', 'BRANCH', 'Name', 'Cash Advance Amount', 'Permanent Authentication Code',
  'Working Days ( days duty in this cut-off Pay)', 'Request ID', 'Purpose', 'Crediting Date (auto)',
  'Cutoff Period (auto)', 'Working Days (This Cutoff)', 'Status', 'Processor Remarks', 'ATD Compliance (Yes/No)',
  'Approver Remarks', 'Date Approved', 'Forwarded to HR (Yes/No)'
];

var CA_AMOUNTS = [500, 1000, 1500, 2000];

var CA_WINDOW_DAYS = [1, 2, 3]; // Mon, Tue, Wed (Date#getDay style: Sun=0..Sat=6)

var CA_WINDOW_OVERRIDES = {
  AUTO: 'AUTO',
  FORCE_OPEN: 'FORCE_OPEN',
  FORCE_CLOSED: 'FORCE_CLOSED'
};

var STATUS = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  APPROVED: 'Approved',
  REJECTED: 'Rejected'
};

var CUTOFF_PERIODS = ['26-10', '11-25'];

var ROLES = {
  PROCESSOR: 'processor',
  APPROVER: 'approver',
  HR: 'hr',
  ADMIN: 'admin'
};

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function getRequestsSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(REQUESTS_TAB);
  if (!sheet) {
    throw new Error('Requests tab "' + REQUESTS_TAB + '" not found. Update REQUESTS_TAB in Code.gs.');
  }
  return sheet;
}

function getRolesSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(ROLES_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(ROLES_TAB);
    sheet.appendRow(['Username', 'Password', 'Role', 'Name']);
    sheet.appendRow(['admin', 'CHANGE_ME', ROLES.ADMIN, 'Administrator']);
    sheet.appendRow(['processor1', 'CHANGE_ME', ROLES.PROCESSOR, 'PLACEHOLDER']);
    sheet.appendRow(['approver1', 'CHANGE_ME', ROLES.APPROVER, 'PLACEHOLDER']);
    sheet.appendRow(['hr1', 'CHANGE_ME', ROLES.HR, 'PLACEHOLDER']);
  }
  return sheet;
}

/**
 * Identity whitelist so a request can't be submitted under someone else's identity.
 * User populates rows directly. Columns (in order): Last Name, First Name, Middle Name, Date of Birth.
 * Middle Name should be "None" for employees who don't have one. No Branch column here — Branch is
 * only ever collected as a CA-request field, not checked against this list.
 */
function getMasterlistSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(MASTERLIST_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(MASTERLIST_TAB);
    sheet.appendRow(['Last Name', 'First Name', 'Middle Name', 'Date of Birth']);
  }
  return sheet;
}

var NO_MIDDLE_NAME_TOKENS = ['none', 'n/a', 'na', 'wala', '-', ''];

/** Collapses "no middle name" variants (None, N/A, Wala, blank, ...) to '' so they all compare equal. */
function normalizeMiddleName_(value) {
  var v = String(value || '').trim().toLowerCase();
  return NO_MIDDLE_NAME_TOKENS.indexOf(v) !== -1 ? '' : v;
}

/** Normalizes a Date object or date-ish string to 'yyyy-MM-dd' (Asia/Manila) so sheet values and form input compare equal. */
function normalizeDateForCompare_(value) {
  if (!value) return '';
  var d = new Date(value);
  if (isNaN(d.getTime())) return String(value).trim();
  return Utilities.formatDate(d, 'Asia/Manila', 'yyyy-MM-dd');
}

/** Generic Key/Value settings store, e.g. the CA request window override. */
function getSettingsSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SETTINGS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_TAB);
    sheet.appendRow(['Key', 'Value']);
    sheet.appendRow(['CA_WINDOW_OVERRIDE', CA_WINDOW_OVERRIDES.AUTO]);
  }
  return sheet;
}

function getSetting_(key) {
  var sheet = getSettingsSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) return String(data[i][1]).trim();
  }
  return '';
}

function setSetting_(key, value) {
  var sheet = getSettingsSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

/** True only if Last Name+First Name+Middle Name+Date of Birth all match the same Masterlist row (trimmed, case-insensitive). */
function isValidEmployee_(lastName, firstName, middleName, birthday) {
  var needleLast = String(lastName).trim().toLowerCase();
  var needleFirst = String(firstName).trim().toLowerCase();
  var needleMiddle = normalizeMiddleName_(middleName);
  var needleBirthday = normalizeDateForCompare_(birthday);
  var sheet = getMasterlistSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === needleLast &&
      String(data[i][1]).trim().toLowerCase() === needleFirst &&
      normalizeMiddleName_(data[i][2]) === needleMiddle &&
      normalizeDateForCompare_(data[i][3]) === needleBirthday) {
      return true;
    }
  }
  return false;
}

/** Client-callable (no PIN) — chatbot calls this right after collecting identity fields, before asking any CA details. */
function verifyIdentity(lastName, firstName, middleName, birthday) {
  return isValidEmployee_(lastName, firstName, middleName, birthday);
}

var MASTERLIST_BRANCH_COL = 6; // Column F — a flat reference list of branch names, not tied to any specific row/employee.

/** Client-callable (no PIN) — powers the searchable branch dropdown in the chatbot. */
function getBranchList() {
  var sheet = getMasterlistSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, MASTERLIST_BRANCH_COL, lastRow - 1, 1).getValues();
  var seen = {};
  var branches = [];
  values.forEach(function (row) {
    var v = String(row[0] || '').trim();
    if (!v || seen[v.toLowerCase()]) return;
    seen[v.toLowerCase()] = true;
    branches.push(v);
  });
  branches.sort(function (a, b) { return a.localeCompare(b); });
  return branches;
}

/** Auto-capitalizes to Proper Case (first letter of each word/hyphen-part), regardless of how it was typed. */
function toProperCase_(value) {
  return String(value || '').trim().toLowerCase().replace(/(^|[\s\-])([a-z])/g, function (match, sep, letter) {
    return sep + letter.toUpperCase();
  });
}

/** "Last Name, First Name Middle Name" (Proper Case) — the single display/storage format used in the Requests sheet's Name column. */
function buildFullName_(lastName, firstName, middleName) {
  var name = toProperCase_(lastName) + ', ' + toProperCase_(firstName);
  if (normalizeMiddleName_(middleName) !== '') {
    name += ' ' + toProperCase_(middleName);
  }
  return name;
}

/** AUTO = Mon-Wed only (Asia/Manila); FORCE_OPEN/FORCE_CLOSED bypass the day check entirely. */
function isCaWindowOpen_() {
  var override = getSetting_('CA_WINDOW_OVERRIDE') || CA_WINDOW_OVERRIDES.AUTO;
  if (override === CA_WINDOW_OVERRIDES.FORCE_OPEN) return true;
  if (override === CA_WINDOW_OVERRIDES.FORCE_CLOSED) return false;
  var dayNames = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var dow = dayNames[Utilities.formatDate(new Date(), 'Asia/Manila', 'EEE')];
  return CA_WINDOW_DAYS.indexOf(dow) !== -1;
}

/** Client-callable (no PIN) — the chatbot needs this before letting anyone start a new request. */
function getCaWindowStatus() {
  return {
    open: isCaWindowOpen_(),
    override: getSetting_('CA_WINDOW_OVERRIDE') || CA_WINDOW_OVERRIDES.AUTO
  };
}

/** HR-only: force the CA window open/closed, or reset to the Mon-Wed auto schedule. */
function setCaWindowOverride(value, username, password) {
  requireAccess_(username, password, ROLES.HR);
  if (Object.keys(CA_WINDOW_OVERRIDES).indexOf(value) === -1) {
    throw new Error('Invalid override value: ' + value);
  }
  setSetting_('CA_WINDOW_OVERRIDE', value);
  return getCaWindowStatus();
}

/** Next Friday on/after today (Asia/Manila), same-day if today is already Friday — never rolls into the past. */
function computeCreditingDate_() {
  var tz = 'Asia/Manila';
  var now = new Date(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'00:00:00"));
  var dow = now.getDay(); // Sun=0..Sat=6
  var daysUntilFriday = (5 - dow + 7) % 7;
  now.setDate(now.getDate() + daysUntilFriday);
  return Utilities.formatDate(now, tz, 'yyyy-MM-dd');
}

/** Auto-determines the applicable cutoff period from today's day-of-month (Asia/Manila): 11-25 -> '11-25', else -> '26-10'. */
function computeCutoffPeriod_() {
  var dayOfMonth = Number(Utilities.formatDate(new Date(), 'Asia/Manila', 'd'));
  return (dayOfMonth >= 11 && dayOfMonth <= 25) ? CUTOFF_PERIODS[1] : CUTOFF_PERIODS[0];
}

/** Ensures the new columns (G onward) have the correct headers. Safe to run multiple times. */
function ensureRequestHeaders_() {
  var sheet = getRequestsSheet_();
  var range = sheet.getRange(1, 1, 1, REQUEST_HEADERS.length);
  range.setValues([REQUEST_HEADERS]);
}

/**
 * Admin.html is a real login (Username + Password), not per-tab PINs — staff aren't reliably on a
 * Google Workspace domain so this isn't Google-account-based. Each account has exactly one role;
 * "admin" is a special role with access to every section. Every protected server function
 * re-checks the credentials (stateless) — the client just remembers the verified session in
 * sessionStorage so the user isn't logging in again on every click.
 */

/** Looks up a Username+Password match in the Roles tab. Returns {username, role, name} or null. */
function findUser_(username, password) {
  var needleUser = String(username || '').trim().toLowerCase();
  var needlePass = String(password || '').trim();
  if (!needleUser || !needlePass) return null;
  var sheet = getRolesSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var rowUser = String(data[i][0]).trim().toLowerCase();
    var rowPass = String(data[i][1]).trim();
    if (rowUser === needleUser && rowPass !== '' && rowPass === needlePass) {
      return { username: rowUser, role: String(data[i][2]).trim().toLowerCase(), name: String(data[i][3]).trim() };
    }
  }
  return null;
}

/** Throws unless the credentials belong to requiredRole OR the admin role (admin can access everything). */
function requireAccess_(username, password, requiredRole) {
  var user = findUser_(username, password);
  if (!user) {
    throw new Error('Invalid login.');
  }
  if (user.role !== requiredRole && user.role !== ROLES.ADMIN) {
    throw new Error('Access denied for this section.');
  }
}

/** Client-callable — the login screen calls this once. Returns {success:false} on any mismatch, no hint which part was wrong. */
function login(username, password) {
  var user = findUser_(username, password);
  if (!user) return { success: false };
  return { success: true, role: user.role, name: user.name };
}

function validateNewRequest_(data) {
  var errors = [];
  data = data || {};

  if (!isCaWindowOpen_()) {
    errors.push('Sarado muna ang pagtanggap ng CA requests ngayon. Bukas lang ito tuwing Lunes hanggang Miyerkules.');
    return { valid: false, errors: errors };
  }

  if (!data.branch || !String(data.branch).trim()) errors.push('Branch is required.');
  if (!data.lastName || !String(data.lastName).trim()) errors.push('Last name is required.');
  if (!data.firstName || !String(data.firstName).trim()) errors.push('First name is required.');
  if (!data.birthday || !String(data.birthday).trim()) errors.push('Date of birth is required.');

  var amount = Number(data.amount);
  if (!data.amount || isNaN(amount) || CA_AMOUNTS.indexOf(amount) === -1) {
    errors.push('Amount must be one of: ' + CA_AMOUNTS.join(', ') + '.');
  }

  if (!data.purpose || !String(data.purpose).trim()) errors.push('Purpose is required.');

  // Cutoff period is auto-computed server-side from today's date — not a client input, nothing to validate here.

  var daysPresent = Number(data.daysPresent);
  if (data.daysPresent === undefined || data.daysPresent === '' || isNaN(daysPresent) || daysPresent < 0 || !Number.isInteger(daysPresent)) {
    errors.push('Working days is required and must be a whole number of 0 or more.');
  }

  if (data.lastName && data.firstName &&
    !isValidEmployee_(data.lastName, data.firstName, data.middleName, data.birthday)) {
    errors.push('Hindi ka na-verify sa aming listahan ng empleyado. Kontakin ang HR kung tama ang lahat ng detalye mo.');
  }

  if (data.lastName && data.firstName) {
    var needleLast = normalizeNameForSearch_(data.lastName);
    var needleFirst = normalizeNameForSearch_(data.firstName);
    var hasOpenRequest = getAllRequests_().some(function (r) {
      var haystack = normalizeNameForSearch_(r.name);
      return haystack.indexOf(needleLast) !== -1 && haystack.indexOf(needleFirst) !== -1 &&
        (r.status === STATUS.PENDING || r.status === STATUS.PROCESSING);
    });
    if (hasOpenRequest) {
      errors.push('You already have a pending or in-review CA request. Please wait for it to be resolved before submitting another.');
    }
  }

  return { valid: errors.length === 0, errors: errors };
}

function rowToRequestObject_(row, rowIndex) {
  return {
    rowIndex: rowIndex,
    timestamp: row[COL.TIMESTAMP - 1],
    branch: row[COL.BRANCH - 1],
    name: row[COL.NAME - 1],
    amount: row[COL.AMOUNT - 1],
    requestId: row[COL.REQUEST_ID - 1],
    purpose: row[COL.PURPOSE - 1],
    dateNeeded: row[COL.DATE_NEEDED - 1],
    cutoffPeriod: row[COL.CUTOFF_PERIOD - 1],
    daysPresent: row[COL.DAYS_PRESENT - 1],
    status: row[COL.STATUS - 1],
    processorRemarks: row[COL.PROCESSOR_REMARKS - 1],
    atdCompliance: row[COL.ATD_COMPLIANCE - 1],
    approverRemarks: row[COL.APPROVER_REMARKS - 1],
    dateApproved: row[COL.DATE_APPROVED - 1],
    forwardedToHr: row[COL.FORWARDED_TO_HR - 1]
  };
}

/** Returns every request row as an object. rowIndex is 1-based and includes the header row offset. */
function getAllRequests_() {
  var sheet = getRequestsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, REQUEST_HEADERS.length).getValues();
  return values.map(function (row, i) {
    return rowToRequestObject_(row, i + 2);
  });
}

function findRequestByIdOrThrow_(requestId) {
  var all = getAllRequests_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].requestId === requestId) return all[i];
  }
  throw new Error('Request not found: ' + requestId);
}

/** Reads-increments-writes the persisted counter in Settings. Caller must already hold the write lock. */
function getNextRequestSequence_() {
  var current = Number(getSetting_('LAST_SCA_SEQUENCE')) || 0;
  var next = current + 1;
  setSetting_('LAST_SCA_SEQUENCE', String(next));
  return next;
}

/** e.g. 7 -> "SCA#000007" */
function formatRequestId_(seq) {
  var padded = String(seq);
  while (padded.length < 6) padded = '0' + padded;
  return 'SCA#' + padded;
}

/**
 * Employee-facing: create a new CA request. Returns {success, requestId} or {success:false, errors}.
 * The sequence-number generation + row write is wrapped in a script lock so simultaneous submissions
 * from different employees never collide on the same SCA# — each one just waits its turn (milliseconds).
 */
function createRequest(data) {
  var validation = validateNewRequest_(data);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getRequestsSheet_();
    var requestId = formatRequestId_(getNextRequestSequence_());
    var creditingDate = computeCreditingDate_();
    var cutoffPeriod = computeCutoffPeriod_();
    var row = [];
    row[COL.TIMESTAMP - 1] = new Date();
    row[COL.BRANCH - 1] = data.branch;
    row[COL.NAME - 1] = buildFullName_(data.lastName, data.firstName, data.middleName);
    row[COL.AMOUNT - 1] = Number(data.amount);
    row[COL.AUTH_CODE - 1] = '';
    row[COL.WORKING_DAYS_LEGACY - 1] = '';
    row[COL.REQUEST_ID - 1] = requestId;
    row[COL.PURPOSE - 1] = data.purpose;
    row[COL.DATE_NEEDED - 1] = creditingDate;
    row[COL.CUTOFF_PERIOD - 1] = cutoffPeriod;
    row[COL.DAYS_PRESENT - 1] = Number(data.daysPresent);
    row[COL.STATUS - 1] = STATUS.PENDING;
    row[COL.PROCESSOR_REMARKS - 1] = '';
    row[COL.ATD_COMPLIANCE - 1] = '';
    row[COL.APPROVER_REMARKS - 1] = '';
    row[COL.DATE_APPROVED - 1] = '';
    row[COL.FORWARDED_TO_HR - 1] = '';

    sheet.appendRow(row);
    return { success: true, requestId: requestId, creditingDate: creditingDate, cutoffPeriod: cutoffPeriod };
  } finally {
    lock.releaseLock();
  }
}

/** Strips commas and collapses whitespace so "Last, First", "Last First", and "First Last" all compare the same way. */
function normalizeNameForSearch_(value) {
  return String(value || '').toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Employee-facing: lookup a single request by Last Name + its SCA# Request Number together. Both must
 * match — this is the "no real login" flow's actual gate, since the Request Number is only ever shown
 * to the person who submitted it (in the confirmation card). A bare name is no longer enough on its own
 * to see someone else's CA history.
 */
function getRequestByLastNameAndId(lastName, requestId) {
  var needleLast = normalizeNameForSearch_(lastName);
  var needleId = String(requestId || '').trim().toLowerCase();
  if (!needleLast || !needleId) return [];
  return getAllRequests_().filter(function (r) {
    var haystack = normalizeNameForSearch_(r.name);
    return haystack.indexOf(needleLast) !== -1 && String(r.requestId || '').trim().toLowerCase() === needleId;
  }).sort(function (a, b) {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });
}

function getPendingForProcessor(username, password) {
  requireAccess_(username, password, ROLES.PROCESSOR);
  return getAllRequests_().filter(function (r) { return r.status === STATUS.PENDING; });
}

function getPendingForApprover(username, password) {
  requireAccess_(username, password, ROLES.APPROVER);
  return getAllRequests_().filter(function (r) { return r.status === STATUS.PROCESSING; });
}

function setRowFields_(rowIndex, fields) {
  var sheet = getRequestsSheet_();
  Object.keys(fields).forEach(function (colName) {
    sheet.getRange(rowIndex, COL[colName]).setValue(fields[colName]);
  });
}

/**
 * Processor reviews a Pending request.
 * action: 'forward' (Pending -> Processing) or 'reject' (Pending -> Rejected, remarks required).
 */
function processorReview(requestId, action, remarks, username, password) {
  requireAccess_(username, password, ROLES.PROCESSOR);
  var req = findRequestByIdOrThrow_(requestId);
  if (req.status !== STATUS.PENDING) {
    throw new Error('Request is not in Pending status.');
  }
  if (action === 'reject' && (!remarks || !String(remarks).trim())) {
    throw new Error('Remarks are required when rejecting a request.');
  }

  var newStatus = action === 'forward' ? STATUS.PROCESSING : STATUS.REJECTED;
  setRowFields_(req.rowIndex, {
    STATUS: newStatus,
    PROCESSOR_REMARKS: remarks || ''
  });
  return { success: true };
}

/**
 * Approver reviews a Processing request.
 * action: 'approve' (Processing -> Approved, forwarded to HR) or 'reject' (Processing -> Rejected, remarks required).
 */
function approverReview(requestId, action, atdCompliance, remarks, username, password) {
  requireAccess_(username, password, ROLES.APPROVER);
  var req = findRequestByIdOrThrow_(requestId);
  if (req.status !== STATUS.PROCESSING) {
    throw new Error('Request is not in Processing status.');
  }
  if (action === 'reject' && (!remarks || !String(remarks).trim())) {
    throw new Error('Remarks are required when rejecting a request.');
  }

  if (action === 'approve') {
    setRowFields_(req.rowIndex, {
      STATUS: STATUS.APPROVED,
      ATD_COMPLIANCE: atdCompliance ? 'Yes' : 'No',
      APPROVER_REMARKS: remarks || '',
      DATE_APPROVED: new Date(),
      FORWARDED_TO_HR: 'Yes'
    });
  } else {
    setRowFields_(req.rowIndex, {
      STATUS: STATUS.REJECTED,
      ATD_COMPLIANCE: atdCompliance ? 'Yes' : 'No',
      APPROVER_REMARKS: remarks || ''
    });
  }
  return { success: true };
}

/**
 * Batch version of processorReview. action: 'forward' | 'reject'. requestIds: array of SCA# strings.
 * Remarks are shared across the whole batch (one textarea in the UI). Per-row failures (already
 * actioned by someone else, unknown id) are collected instead of aborting the whole batch.
 * Returns { succeeded: [{requestId}], failed: [{requestId, reason}] }.
 */
function processorReviewBatch(requestIds, action, remarks, username, password) {
  requireAccess_(username, password, ROLES.PROCESSOR);
  if (action === 'reject' && (!remarks || !String(remarks).trim())) {
    throw new Error('Remarks are required when rejecting a request.');
  }

  var byId = {};
  getAllRequests_().forEach(function (r) { byId[r.requestId] = r; });

  var succeeded = [];
  var failed = [];
  var newStatus = action === 'forward' ? STATUS.PROCESSING : STATUS.REJECTED;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    (requestIds || []).forEach(function (id) {
      var req = byId[id];
      if (!req) { failed.push({ requestId: id, reason: 'Request not found.' }); return; }
      if (req.status !== STATUS.PENDING) {
        failed.push({ requestId: id, reason: 'Request is not in Pending status.' });
        return;
      }
      setRowFields_(req.rowIndex, { STATUS: newStatus, PROCESSOR_REMARKS: remarks || '' });
      succeeded.push({ requestId: id });
    });
  } finally {
    lock.releaseLock();
  }

  return { succeeded: succeeded, failed: failed };
}

/**
 * Batch version of approverReview. action: 'approve' | 'reject'. requestIds: array of SCA# strings.
 * atdCompliance and remarks are shared across the whole batch (one checkbox/textarea in the UI).
 * Returns { succeeded: [{requestId}], failed: [{requestId, reason}] }.
 */
function approverReviewBatch(requestIds, action, atdCompliance, remarks, username, password) {
  requireAccess_(username, password, ROLES.APPROVER);
  if (action === 'reject' && (!remarks || !String(remarks).trim())) {
    throw new Error('Remarks are required when rejecting a request.');
  }

  var byId = {};
  getAllRequests_().forEach(function (r) { byId[r.requestId] = r; });

  var succeeded = [];
  var failed = [];

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    (requestIds || []).forEach(function (id) {
      var req = byId[id];
      if (!req) { failed.push({ requestId: id, reason: 'Request not found.' }); return; }
      if (req.status !== STATUS.PROCESSING) {
        failed.push({ requestId: id, reason: 'Request is not in Processing status.' });
        return;
      }
      if (action === 'approve') {
        setRowFields_(req.rowIndex, {
          STATUS: STATUS.APPROVED,
          ATD_COMPLIANCE: atdCompliance ? 'Yes' : 'No',
          APPROVER_REMARKS: remarks || '',
          DATE_APPROVED: new Date(),
          FORWARDED_TO_HR: 'Yes'
        });
      } else {
        setRowFields_(req.rowIndex, {
          STATUS: STATUS.REJECTED,
          ATD_COMPLIANCE: atdCompliance ? 'Yes' : 'No',
          APPROVER_REMARKS: remarks || ''
        });
      }
      succeeded.push({ requestId: id });
    });
  } finally {
    lock.releaseLock();
  }

  return { succeeded: succeeded, failed: failed };
}

/** HR-facing: rows where Status = Approved, ready for disbursement. CSV export happens client-side from this data. */
function generateHrSummary(username, password) {
  requireAccess_(username, password, ROLES.HR);
  return getAllRequests_()
    .filter(function (r) { return r.status === STATUS.APPROVED; })
    .sort(function (a, b) { return new Date(a.dateApproved) - new Date(b.dateApproved); });
}
