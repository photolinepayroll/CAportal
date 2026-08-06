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
    getApproverQueue: getApproverQueue,
    getForAuthorization: getForAuthorization,
    authorizeBatch: authorizeBatch,
    getTransactionHistory: getTransactionHistory,
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

/**
 * CacheService.getScriptCache() is shared across every user/execution — appropriate here since
 * all roles read the same spreadsheet-backed data. TTLs for Roles/Masterlist are pure safety nets
 * (those tabs are only ever edited by hand in the Sheet, so a short staleness window is fine);
 * Requests/Settings TTLs are also safety nets since every write path explicitly invalidates.
 */
var CACHE_KEYS = {
  REQUESTS: 'cache_requests_v1',
  ROLES: 'cache_roles_v1',
  MASTERLIST: 'cache_masterlist_v1',
  SETTINGS: 'cache_settings_v1'
};
var CACHE_TTL = { REQUESTS: 300, ROLES: 1800, MASTERLIST: 900, SETTINGS: 120 };

function cacheGetOrSet_(key, ttlSeconds, computeFn) {
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get(key);
    if (cached !== null) return JSON.parse(cached);
  } catch (e) {
    // Corrupt cache entry — fall through and recompute.
  }
  var value = computeFn();
  try {
    cache.put(key, JSON.stringify(value), ttlSeconds);
  } catch (e) {
    // Value too large for the 100KB/key limit or other put failure — not fatal, just uncached this time.
  }
  return value;
}

function cacheInvalidate_(key) {
  CacheService.getScriptCache().remove(key);
}

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
  FORWARDED_TO_HR: 17,
  TRANSACTION_BATCH_NO: 18,
  DATE_AUTHORIZED: 19,
  AUTHORIZED_BY: 20
};

var REQUEST_HEADERS = [
  'Timestamp', 'BRANCH', 'Name', 'Cash Advance Amount', 'Permanent Authentication Code',
  'Working Days ( days duty in this cut-off Pay)', 'Request ID', 'Purpose', 'Crediting Date (auto)',
  'Cutoff Period (auto)', 'Working Days (This Cutoff)', 'Status', 'Processor Remarks', 'ATD Compliance (Yes/No)',
  'Approver Remarks', 'Date Approved', 'Forwarded to HR (Yes/No)', 'Transaction Batch No.', 'Date Authorized',
  'Authorized By'
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
  HOLD: 'Hold',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  DISBURSED: 'Disbursed'
};

var CUTOFF_PERIODS = ['26-10', '11-25'];

var ROLES = {
  PROCESSOR: 'processor',
  APPROVER: 'approver',
  AUTHORIZER: 'authorizer',
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
    sheet.appendRow(['authorizer1', 'CHANGE_ME', ROLES.AUTHORIZER, 'PLACEHOLDER']);
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

function getSettingsData_() {
  return cacheGetOrSet_(CACHE_KEYS.SETTINGS, CACHE_TTL.SETTINGS, function () {
    var sheet = getSettingsSheet_();
    var data = sheet.getDataRange().getValues();
    var map = {};
    for (var i = 1; i < data.length; i++) {
      map[String(data[i][0]).trim()] = String(data[i][1]).trim();
    }
    return map;
  });
}

function getSetting_(key) {
  return getSettingsData_()[key] || '';
}

function setSetting_(key, value) {
  var sheet = getSettingsSheet_();
  var data = sheet.getDataRange().getValues();
  var found = false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      found = true;
      break;
    }
  }
  if (!found) sheet.appendRow([key, value]);
  cacheInvalidate_(CACHE_KEYS.SETTINGS);
}

function getMasterlistData_() {
  return cacheGetOrSet_(CACHE_KEYS.MASTERLIST, CACHE_TTL.MASTERLIST, function () {
    return getMasterlistSheet_().getDataRange().getValues();
  });
}

/** True only if Last Name+First Name+Middle Name+Date of Birth all match the same Masterlist row (trimmed, case-insensitive). */
function isValidEmployee_(lastName, firstName, middleName, birthday) {
  var needleLast = String(lastName).trim().toLowerCase();
  var needleFirst = String(firstName).trim().toLowerCase();
  var needleMiddle = normalizeMiddleName_(middleName);
  var needleBirthday = normalizeDateForCompare_(birthday);
  var data = getMasterlistData_();
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

/** Authorizer-only: force the CA window open/closed, or reset to the Mon-Wed auto schedule. */
function setCaWindowOverride(value, username, password) {
  requireAccess_(username, password, ROLES.AUTHORIZER);
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

/**
 * 11:00 AM on the Wednesday of the current calendar week (Asia/Manila) — always "the Wednesday
 * on/after today," same-day if today is already Wednesday. Recomputed fresh every call, not stored
 * per-row, so it self-resets every Monday and applies uniformly regardless of which day (Mon/Tue/Wed)
 * a request entered Hold status. Deliberately independent of CA_WINDOW_OVERRIDE/isCaWindowOpen_ — a
 * force-reopened window does not extend this deadline.
 */
function computeHoldDeadline_() {
  var tz = 'Asia/Manila';
  var now = new Date(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'00:00:00"));
  var dow = now.getDay(); // Sun=0..Sat=6
  var daysUntilWed = (3 - dow + 7) % 7;
  now.setDate(now.getDate() + daysUntilWed);
  now.setHours(11, 0, 0, 0);
  return now;
}

/** True once "now" has passed this week's Wed-11am Hold deadline. */
function isPastHoldDeadline_() {
  return new Date() >= computeHoldDeadline_();
}

/** Ensures the new columns (G onward) have the correct headers. Safe to run multiple times. */
function ensureRequestHeaders_() {
  var sheet = getRequestsSheet_();
  var range = sheet.getRange(1, 1, 1, REQUEST_HEADERS.length);
  var current = range.getValues()[0];
  var matches = current.length === REQUEST_HEADERS.length &&
    current.every(function (v, i) { return String(v) === REQUEST_HEADERS[i]; });
  if (!matches) range.setValues([REQUEST_HEADERS]);
}

/**
 * Admin.html is a real login (Username + Password), not per-tab PINs — staff aren't reliably on a
 * Google Workspace domain so this isn't Google-account-based. Each account has exactly one role;
 * "admin" is a special role with access to every section. Every protected server function
 * re-checks the credentials (stateless) — the client just remembers the verified session in
 * sessionStorage so the user isn't logging in again on every click.
 */

function getRolesData_() {
  return cacheGetOrSet_(CACHE_KEYS.ROLES, CACHE_TTL.ROLES, function () {
    return getRolesSheet_().getDataRange().getValues();
  });
}

/** Looks up a Username+Password match in the Roles tab. Returns {username, role, name} or null. */
function findUser_(username, password) {
  var needleUser = String(username || '').trim().toLowerCase();
  var needlePass = String(password || '').trim();
  if (!needleUser || !needlePass) return null;
  var data = getRolesData_();
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
        (r.status === STATUS.PENDING || r.status === STATUS.PROCESSING || r.status === STATUS.HOLD);
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
    forwardedToHr: row[COL.FORWARDED_TO_HR - 1],
    transactionBatchNo: row[COL.TRANSACTION_BATCH_NO - 1],
    dateAuthorized: row[COL.DATE_AUTHORIZED - 1],
    authorizedBy: row[COL.AUTHORIZED_BY - 1]
  };
}

/** Returns every request row as an object. rowIndex is 1-based and includes the header row offset. */
function getAllRequests_() {
  return cacheGetOrSet_(CACHE_KEYS.REQUESTS, CACHE_TTL.REQUESTS, function () {
    var sheet = getRequestsSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var values = sheet.getRange(2, 1, lastRow - 1, REQUEST_HEADERS.length).getValues();
    return values.map(function (row, i) {
      return rowToRequestObject_(row, i + 2);
    });
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

/** Reads-increments-writes the persisted batch/transaction counter in Settings. Caller must already hold the write lock. */
function getNextBatchSequence_() {
  var current = Number(getSetting_('LAST_BATCH_SEQUENCE')) || 0;
  var next = current + 1;
  setSetting_('LAST_BATCH_SEQUENCE', String(next));
  return next;
}

/** e.g. 7 -> "TXN#000007" */
function formatBatchId_(seq) {
  var padded = String(seq);
  while (padded.length < 6) padded = '0' + padded;
  return 'TXN#' + padded;
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
    cacheInvalidate_(CACHE_KEYS.REQUESTS);
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

/**
 * Everything relevant to the Approver tab: currently-Processing (For Approval), Hold, Approved, and
 * Rejected-at-the-Approver-stage rows. A Rejected row counts as "at the Approver stage" iff
 * APPROVER_REMARKS is non-empty — approverReview/approverReviewBatch's reject branches always
 * require non-empty remarks and are the only code path that ever writes APPROVER_REMARKS, so this
 * reliably excludes rows the Processor rejected before they ever reached the Approver.
 */
function getApproverQueue(username, password) {
  requireAccess_(username, password, ROLES.APPROVER);
  return getAllRequests_().filter(function (r) {
    return r.status === STATUS.PROCESSING ||
      r.status === STATUS.HOLD ||
      r.status === STATUS.APPROVED ||
      (r.status === STATUS.REJECTED && String(r.approverRemarks || '').trim() !== '');
  });
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
 * newAmount (only consulted when action === 'forward'): the Processor's corrected CA amount. Must
 * be one of CA_AMOUNTS. If it differs from the request's current amount, the change is written and
 * a note is auto-prepended to PROCESSOR_REMARKS so the Approver/HR can see the correction.
 */
function processorReview(requestId, action, remarks, newAmount, username, password) {
  requireAccess_(username, password, ROLES.PROCESSOR);
  var req = findRequestByIdOrThrow_(requestId);
  if (req.status !== STATUS.PENDING) {
    throw new Error('Request is not in Pending status.');
  }
  if (action === 'reject' && (!remarks || !String(remarks).trim())) {
    throw new Error('Remarks are required when rejecting a request.');
  }

  var finalRemarks = remarks || '';
  var fields = {
    STATUS: action === 'forward' ? STATUS.PROCESSING : STATUS.REJECTED,
    PROCESSOR_REMARKS: finalRemarks
  };

  if (action === 'forward' && newAmount !== undefined && newAmount !== null && newAmount !== '') {
    var amt = Number(newAmount);
    if (CA_AMOUNTS.indexOf(amt) === -1) {
      throw new Error('Amount must be one of: ' + CA_AMOUNTS.join(', ') + '.');
    }
    if (amt !== Number(req.amount)) {
      fields.AMOUNT = amt;
      fields.PROCESSOR_REMARKS = (
        'Amount corrected from ₱' + req.amount + ' to ₱' + amt + '.' +
        (finalRemarks ? ' ' + finalRemarks : '')
      ).trim();
    }
  }

  setRowFields_(req.rowIndex, fields);
  cacheInvalidate_(CACHE_KEYS.REQUESTS);
  return { success: true };
}

/**
 * Approver reviews a Processing (or previously Held) request.
 * action: 'approve' (-> Approved, forwarded to HR), 'reject' (-> Rejected, remarks required), or
 * 'hold' (Processing -> Hold only — buying time, not a decision, so no ATD/remarks requirement).
 * A Held request can still be approved or rejected at any time before the auto-reject trigger
 * catches it past the Wed-11am deadline (see autoRejectExpiredHolds_).
 */
function approverReview(requestId, action, atdCompliance, remarks, username, password) {
  requireAccess_(username, password, ROLES.APPROVER);
  var req = findRequestByIdOrThrow_(requestId);
  if (action === 'hold') {
    if (req.status !== STATUS.PROCESSING) {
      throw new Error('Request is not in Processing status.');
    }
  } else if (req.status !== STATUS.PROCESSING && req.status !== STATUS.HOLD) {
    throw new Error('Request is not in Processing or Hold status.');
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
  } else if (action === 'hold') {
    setRowFields_(req.rowIndex, {
      STATUS: STATUS.HOLD,
      APPROVER_REMARKS: remarks || req.approverRemarks || ''
    });
  } else {
    setRowFields_(req.rowIndex, {
      STATUS: STATUS.REJECTED,
      ATD_COMPLIANCE: atdCompliance ? 'Yes' : 'No',
      APPROVER_REMARKS: remarks || ''
    });
  }
  cacheInvalidate_(CACHE_KEYS.REQUESTS);
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
    cacheInvalidate_(CACHE_KEYS.REQUESTS);
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
      if (req.status !== STATUS.PROCESSING && req.status !== STATUS.HOLD) {
        failed.push({ requestId: id, reason: 'Request is not in Processing or Hold status.' });
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
    cacheInvalidate_(CACHE_KEYS.REQUESTS);
  } finally {
    lock.releaseLock();
  }

  return { succeeded: succeeded, failed: failed };
}

/** Authorizer-facing: rows where Status = Approved, ready for disbursement. CSV/PDF export happens client-side from this data. */
function getForAuthorization(username, password) {
  requireAccess_(username, password, ROLES.AUTHORIZER);
  return getAllRequests_()
    .filter(function (r) { return r.status === STATUS.APPROVED; })
    .sort(function (a, b) { return new Date(a.dateApproved) - new Date(b.dateApproved); });
}

/**
 * Authorizer-facing: one-click batch disbursement. Every selected request (must currently be
 * Approved) is stamped with the same new TXN# batch id, DATE_AUTHORIZED, and AUTHORIZED_BY, and
 * flips to Disbursed — which is exactly what makes it disappear from getForAuthorization's list.
 * "One batch, one transaction number": the batch id/timestamp are generated once and shared across
 * every row in this call, inside the same lock, mirroring createRequest's SCA# generation.
 * Returns { succeeded: [{requestId}], failed: [{requestId, reason}], batchId }.
 */
function authorizeBatch(requestIds, username, password) {
  requireAccess_(username, password, ROLES.AUTHORIZER);
  if (!requestIds || !requestIds.length) {
    throw new Error('No requests selected.');
  }
  var user = findUser_(username, password);

  var succeeded = [];
  var failed = [];
  var batchId;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var byId = {};
    getAllRequests_().forEach(function (r) { byId[r.requestId] = r; });

    batchId = formatBatchId_(getNextBatchSequence_());
    var dateAuthorized = new Date();

    requestIds.forEach(function (id) {
      var req = byId[id];
      if (!req) { failed.push({ requestId: id, reason: 'Request not found.' }); return; }
      if (req.status !== STATUS.APPROVED) {
        failed.push({ requestId: id, reason: 'Request is not in Approved status (already authorized or changed by someone else).' });
        return;
      }
      setRowFields_(req.rowIndex, {
        STATUS: STATUS.DISBURSED,
        TRANSACTION_BATCH_NO: batchId,
        DATE_AUTHORIZED: dateAuthorized,
        AUTHORIZED_BY: user.name || user.username
      });
      succeeded.push({ requestId: id });
    });
    cacheInvalidate_(CACHE_KEYS.REQUESTS);
  } finally {
    lock.releaseLock();
  }

  return { succeeded: succeeded, failed: failed, batchId: batchId };
}

/**
 * Authorizer-facing: every past disbursement batch, newest first, grouped by TRANSACTION_BATCH_NO.
 * Each group carries its own nested `requests` array so the client can expand a batch for preview
 * (and print it) without a second round trip.
 */
function getTransactionHistory(username, password) {
  requireAccess_(username, password, ROLES.AUTHORIZER);
  var rows = getAllRequests_().filter(function (r) { return String(r.transactionBatchNo || '').trim() !== ''; });

  var byBatch = {};
  var order = [];
  rows.forEach(function (r) {
    if (!byBatch[r.transactionBatchNo]) {
      byBatch[r.transactionBatchNo] = {
        batchId: r.transactionBatchNo,
        dateAuthorized: r.dateAuthorized,
        authorizedBy: r.authorizedBy,
        count: 0,
        totalAmount: 0,
        requests: []
      };
      order.push(r.transactionBatchNo);
    }
    var batch = byBatch[r.transactionBatchNo];
    batch.count += 1;
    batch.totalAmount += Number(r.amount) || 0;
    batch.requests.push(r);
  });

  return order.map(function (id) { return byBatch[id]; })
    .sort(function (a, b) { return new Date(b.dateAuthorized) - new Date(a.dateAuthorized); });
}

/**
 * Time-driven trigger target (installed manually in the Apps Script editor's Triggers page — see
 * deploy checklist). Never client-callable, not in the doPost whitelist. Sweeps any request still on
 * Hold past this week's Wed-11am deadline (computeHoldDeadline_) and auto-rejects it, so a Held
 * request can't block that week's disbursement cycle indefinitely even if no staff member acts on it.
 */
function autoRejectExpiredHolds_() {
  if (!isPastHoldDeadline_()) return;
  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var held = getAllRequests_().filter(function (r) { return r.status === STATUS.HOLD; });
      if (!held.length) return;
      held.forEach(function (row) {
        setRowFields_(row.rowIndex, {
          STATUS: STATUS.REJECTED,
          APPROVER_REMARKS: ('[Auto-rejected: Hold deadline (Wed 11:00 AM) passed.] ' + (row.approverRemarks || '')).trim()
        });
      });
      cacheInvalidate_(CACHE_KEYS.REQUESTS);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error('autoRejectExpiredHolds_ failed: ' + err.message);
  }
}
