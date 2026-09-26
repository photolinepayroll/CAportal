# CA Portal — Photoline Cash Advance Chatbot

## What this is
Employee-facing chatbot + staff review dashboard for Cash Advance (CA) requests at Photoline, a
Philippine retail company. Replaces a manual Google Form + spreadsheet process with a three-step
review workflow (Processor → Approver → Authorizer disbursement) on top of the same Google Sheet.

Sibling project: `photolinepayroll/payslip-chatbot` — same architecture pattern (single-file HTML,
Google Sheet backend, Apps Script security boundary), and this project's Employee-facing UI was
deliberately restyled to match its Messenger-style look (Facebook blue `#1877F2`, message bubbles,
quick-reply buttons) instead of a generic form.

## Stack
No build step, no npm, no framework. Google Apps Script Web App bound to a Google Sheet.
- **Backend:** `Code.gs` — one file, all server functions.
- **Frontend:** `Employee.html` (public, no login) and `Admin.html` (real username/password login), each fully
  self-contained (inline `<style>`/`<script>`, no includes) so they're easy to paste whole into
  the Apps Script editor.
- **Manifest:** `appsscript.json` — `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`. The
  script always runs as the deploying owner regardless of who's visiting, which is why the
  underlying Sheet itself never needs to be shared publicly — only the web app URL is public.

## Routing
`doGet(e)` serves `Employee.html` by default, or `Admin.html` when `?page=admin` is in the URL.
Same deployed URL for both; the query param is the only difference.

## Two hosting modes, one codebase
This repo is deployed in two places simultaneously, same pattern as `payslip-chatbot`:
1. **Apps Script Web App** (`/exec` URL) — the real backend. `Code.gs` only runs here.
2. **GitHub Pages** (`photolinepayroll.github.io/CAportal/`) — a static mirror of just the
   frontend files, talking to the same Apps Script backend over `fetch()` via the
   `LOCAL_WEB_APP_URL` bridge (see below), since GitHub Pages can't run Apps Script code.

`index.html` exists only for GitHub Pages — it's a one-line redirect to `Employee.html`, since
Apps Script's `doGet` doesn't use it at all (it serves the file named `Employee`, not `index`).
Because the two hosts route between Employee/Admin differently (`?page=admin` query string vs.
real separate files), the "Staff Access" / "Employee Portal" footer links are set dynamically at
load time based on whether `google.script.run` exists — see the `DOMContentLoaded` handlers near
the bottom of `Employee.html` and `Admin.html`.

## Data model (single Google Sheet, ID hardcoded as `SHEET_ID` in Code.gs)
- **`Form Responses 1`** (`REQUESTS_TAB`) — the actual CA requests. Columns A–F are legacy
  (from the original Google Form) and are left alone; columns G onward were added by this project.
  `ensureRequestHeaders_()` rewrites the header row on every `doGet` so it's always self-healing.
  `COL` in `Code.gs` is the single source of truth for column positions.
- **`Roles`** — `Username | Password | Role | Name`, one row per staff account. `Role` is
  `processor`, `approver`, `authorizer`, or `admin` (all-access — can open every section). Auto-created
  with placeholder accounts on first load. This is the real login table for `Admin.html` (see
  Security below). `authorizer` was renamed from `hr` — see Business rules below; if you're looking
  at an older Sheet, existing rows still saying `hr` need a one-time manual fix to `authorizer`.
- **`Masterlist`** — `Last Name | First Name | Middle Name | Date of Birth` in columns A–D, plus
  a `Branches` reference list in column F (unrelated to the row it sits next to — just a flat
  list used to populate the searchable branch dropdown via `getBranchList()`). This is the
  identity whitelist requests are verified against before any CA details are even asked.
  Column E = `Status` (`Active`/`Resigned`/`Separated`/`On Leave`; blank or unrecognized = Active,
  see `normalizeEmployeeStatus_`), column G = `Status Updated` (app-written audit text). Both headers
  self-heal in `getMasterlistSheet_()`. Managed from `Admin.html`'s **Employees** tab (see below).
  **Never delete whole Masterlist rows in code**: column F's branch list shares those rows, so
  `deleteEmployees` removes only `A:E` and `G` cells (shift up), and `addEmployees` writes below the
  last non-empty cell in column A instead of using `appendRow`.
- **`Settings`** — generic `Key | Value` store. Currently holds `CA_WINDOW_OVERRIDE`
  (`AUTO`/`FORCE_OPEN`/`FORCE_CLOSED`), `LAST_SCA_SEQUENCE` (the running counter for request IDs),
  and `LAST_BATCH_SEQUENCE` (the running counter for disbursement transaction/batch numbers).

## Business rules encoded in Code.gs (not just UI validation — every rule is re-checked
server-side inside `createRequest`/`validateNewRequest_`, since `Employee.html` is unauthenticated
and its client-side checks are just UX, not security)
- **CA amount**: fixed enum, `CA_AMOUNTS = [500, 1000, 1500, 2000]`. No free-text amounts anywhere,
  including corrections — the Processor can adjust an employee's requested amount when forwarding
  a Pending request (`processorReview`'s `newAmount` param), but it's re-validated against
  `CA_AMOUNTS` server-side just like at creation, and only applied on `action === 'forward'` (never
  on reject, never in batch). If the amount actually changes, an audit note ("Amount corrected from
  ₱X to ₱Y.") is auto-prepended to `PROCESSOR_REMARKS` so the Approver/HR can see the correction.
- **CA window**: normally open Monday–Wednesday only (`isCaWindowOpen_`/`getCaWindowState_`,
  Asia/Manila), **and** closed on payroll dates even when they fall on Mon–Wed: the 11th–15th and
  the 26th–end of month (`CA_PAYROLL_BLACKOUT_RANGES`). `getCaWindowStatus()` returns a `reason`
  (`'payroll'`/`'day'`/`'forced'`) so both UIs can say why it's closed. The Authorizer can force it
  open or closed from `Admin.html`'s Authorizer view regardless of day **or** payroll date, for
  emergencies. Force Open overrides both rules.
- **One successful CA per cutoff period**: an employee cannot submit a new CA request if they
  already have an `Approved` or `Disbursed` request falling inside the *current* cutoff window
  (`validateNewRequest_`, checked against `computeCutoffWindow_()`, which returns actual
  `{start, end}` calendar dates for the window `computeCutoffPeriod_()`'s current instance falls
  in). The check compares each past request's own `timestamp` against those dates — **not** the
  raw recurring `cutoffPeriod` code (`'26-10'`/`'11-25'`) alone, since that code repeats every
  month and comparing it directly would wrongly keep matching a request from a *previous* month's
  instance of the same code, permanently blocking the employee instead of refreshing once the
  period actually ends. A `Rejected` request does not count against this — it frees the employee
  to try again within the same cutoff period. This is separate from (and in addition to) the
  open-request check below; both can block a submission independently. Cutoff periods are 26th
  (previous month) – 10th (current month) and 11th–25th (current month) — see Cutoff period below.
- **Approver Hold + auto-reject deadline**: the Approver can place a Processing request on `Hold`
  instead of deciding immediately (`approverReview`'s `'hold'` action) — a Held request can still be
  approved or rejected at any time. But any request still on Hold after **11:00 AM on the Wednesday
  of the current week** (Asia/Manila, `computeHoldDeadline_`/`isPastHoldDeadline_`) gets
  auto-rejected by `autoRejectExpiredHolds_`, a time-driven Apps Script trigger installed manually
  in the Apps Script editor's Triggers page (not deployable via file paste — see Deployment below).
  This deadline is a fixed calendar checkpoint, independent of `CA_WINDOW_OVERRIDE` — force-reopening
  the window does not extend it.
- **Authorizer batch disbursement**: once a request is `Approved`, the Authorizer selects one or
  more `Approved` requests in `Admin.html`'s Authorizer tab and clicks "Authorize Selected"
  (`authorizeBatch`) — every selected request is stamped with the same new `TXN#000001`-style
  batch/transaction number (sequential, generated the same way as `SCA#` request IDs, under
  `LockService`), a disbursement timestamp, and the authorizing staff member's name, then flips to
  `Disbursed`. One click always produces exactly one transaction number shared across the whole
  batch. Past batches are browsable (and individually CSV/PDF-exportable, with a totals line shown
  before export) in the Authorizer tab's Transaction History view (`getTransactionHistory`), grouped
  by that same batch number. Both PDF exports (For Authorization list, per-batch) share one title,
  "Cash Advance Disbursement", and leave all three signatory lines blank (no auto-filled preparer
  name) — the transaction number for a per-batch export lives in the print subtitle instead of the
  title.
- **Processor Export CSV/PDF**: unlike the Authorizer export (a post-authorization audit record),
  the Processor Queue's Export CSV/PDF is a pre-decision review sheet — every row carries an
  intentionally blank "Remarks" column (both formats) for a processor to hand-annotate while
  reviewing away from the screen, and the PDF footer has two blank signatory lines, "Prepared by" /
  "Checked by" (vs. the Authorizer PDF's three). Both exports respect the tab's current status/name/branch
  filter, not the full unfiltered queue.
- **Processor status filter**: the Processor tab mirrors the Approver tab's three filters (status,
  name, branch). `getProcessorQueue` returns every request and `Admin.html` buckets them client-side
  (`procStatusBucket_`): **Pending** (actionable, the default), **Forwarded** (anything past the
  Processor stage, including Approver-rejected), and **Rejected** (Rejected with empty
  `APPROVER_REMARKS`, i.e. rejected by the Processor). Forwarded/Rejected views are read-only.
- **Cutoff period**: auto-computed from today's day-of-month, never asked — 11th–25th ⇒ `11-25`,
  else ⇒ `26-10` (`computeCutoffPeriod_`); that raw code is what's stored in the sheet's
  `Cutoff Period (auto)` column. Everywhere it's *displayed* (Employee.html chat, Admin.html
  tables/CSV/PDF exports), it's shown instead as an actual month/day range, e.g. "Aug 11 - Aug 25"
  or "Aug 26 - Sep 10" (`formatCutoffPeriodLabel_`, surfaced as `cutoffPeriodLabel` alongside the
  raw `cutoffPeriod` on every request object). The label is computed from that specific request's
  own `Timestamp`, not from today's date, since the same raw code repeats every month — Employee.html
  has a client-side mirror (`computeCutoffPeriodPreview()`) for the pre-submission review card, same
  as it already does for the crediting-date preview.
- **Crediting date**: auto-computed as the next Friday on/after submission day, never asked
  (`computeCreditingDate_`) — never rolls into the past even if HR force-opens the window outside
  the normal schedule.
- **Identity verification**: before any CA question is even asked, the chatbot collects Last Name,
  First Name, Middle Name (or "None"), and Birthday, and calls `verifyIdentity()` — all four must
  match one row in `Masterlist`. Only then does it proceed to the actual CA questions. Middle name
  gets folded into the stored `Name` cell as "Last, First Middle" (Proper Case auto-applied via
  `toProperCase_`); there's no separate Middle Name column. `isValidEmployee_` reads `Masterlist`
  directly (deliberately **not** through `CacheService`) so hand-added rows verify immediately, and
  normalizes names first (collapses non-breaking/odd whitespace, strips zero-width chars) so rows
  pasted from Word/Excel/PDF still match. (`findEmployee_` holds that matching logic now;
  `isValidEmployee_` wraps it.)
- **Inactive employees can't file**: an employee whose Masterlist status isn't `Active` (Resigned,
  Separated, On Leave, meaning no upcoming salary to deduct the CA from) is blocked.
  `verifyIdentity` returns `{valid, eligible}` and the chatbot shows a generic "not eligible, contact
  HR" message (the status itself is never sent to the public page). `validateNewRequest_` re-checks
  server-side. Already-open requests are **not** auto-changed. `attachEmployeeStatus_` adds
  `employeeStatus` to rows from `getProcessorQueue`/`getApproverQueue`/`getForAuthorization`, and
  `Admin.html` shows a red "Inactive: …" badge next to the name (screen only, not in exports).
- **Employees tab** (`Admin.html`, admin + authorizer; `canAccess` special-cases the `employees`
  view): search/filter the Masterlist, change status (`setEmployeeStatus`), edit a wrong
  Last/First/Middle Name or Date of Birth on an existing row (`editEmployee`, columns A–D only —
  never touches Status/Status Updated), add single or batch by uploading a CSV/Excel file
  (downloadable template; `.xlsx` is read client-side with SheetJS, lazy-loaded from
  cdn.jsdelivr.net only when needed) or pasting rows (`addEmployees`, with a client-side preview;
  the server re-validates and skips duplicates/bad birthdays with reasons), and delete single or
  checked rows (`deleteEmployees`). All writes run under `LockService` and re-check that the target
  row still holds the expected name before touching it, since staff can also edit/sort the sheet by
  hand (`editEmployee` additionally excludes its own row from the duplicate-identity check).
  Deleting keeps past CA requests. Note: `editEmployee` corrects the Masterlist going forward only —
  `createRequest` already snapshotted the employee's name as a plain string onto any past request
  rows (see `buildFullName_`), so those aren't retroactively renamed, and `attachEmployeeStatus_`'s
  inactive-employee badge (which matches on the *current* Masterlist name) can briefly stop matching
  an older pending request of a renamed inactive employee — cosmetic only.
- **Request ID**: `SCA#000001`-style, sequential, generated under `LockService.getScriptLock()` so
  concurrent submissions from different employees can never collide on the same number.
- **"My Requests" self-service lookup**: requires Last Name **and** the SCA# together
  (`getRequestByLastNameAndId`) — a bare name is not enough to see someone else's CA history. The
  SCA# is only ever shown to the person who submitted that request.

## Security model
- Sheet itself: kept **private** (not shared) — verified via `docs.google.com/.../export` 401ing.
  It doesn't need to be shared because of `executeAs: USER_DEPLOYING`.
- `doPost` (used only by the local-file preview bridge, see below) has a hardcoded function
  whitelist — it can never call anything outside that list, regardless of what a client sends.
- `Admin.html` is a real login (`login(username, password)`), not per-tab PINs. Every protected
  server function calls `requireAccess_(username, password, requiredRole)`, which re-validates the
  credentials on every single call (stateless) and passes if the account's role matches
  `requiredRole` **or** is `admin` — admin always has access to every section. The client stores
  the verified `{username, password, role, name}` once in `sessionStorage` after login so the user
  isn't retyping credentials on every click; `Admin.html`'s `enterDashboard()` only wires up click
  handlers for the tab(s) the role can reach — the other tabs are visually disabled and never even
  attempt a request.
- **Known open risk, not yet mitigated**: no rate-limiting/lockout on login attempts
  (`findUser_`/`login`). Flagged to the project owner; add attempt throttling (e.g. a cooldown
  keyed in `Settings`) if this becomes a real concern.

## Local development / testing without redeploying
Both `Employee.html` and `Admin.html` have a `gs()` wrapper that detects whether
`google.script.run` exists. When it doesn't (i.e. the file was opened directly instead of served
by Apps Script), it falls back to `fetch()`-ing `window.LOCAL_WEB_APP_URL` (set near the top of
each file) with `{fn, args}` as a `text/plain` POST body — `doPost` in `Code.gs` is the receiving
end of that bridge. This means you can iterate on the HTML/CSS/JS locally against the **real live
Sheet** without touching the Apps Script editor for every tweak; you only need to paste-and-deploy
when `Code.gs` itself changes.

`gs()` is also the resilience layer for the deployed fetch bridge (GitHub Pages hitting the live
`/exec` URL), since that path is exposed to real network conditions the `google.script.run` path
isn't: each attempt is capped at 45s via `AbortController`, an HTML-interstitial or raw network
failure gets one retry, and read-only calls get up to 3 attempts total — but write functions
(`createRequest`, `processorReview`, `approverReview`, both batch variants, `authorizeBatch`,
`setCaWindowOverride`) only auto-retry the provably-safe HTML-interstitial case, since a genuine
network failure is ambiguous about whether the write already landed server-side and blind retrying
there risks a duplicate request/review/disbursement. `google.script.run` results also get a
null-to-`[]` guard, since it silently delivers an empty array as `null` where the fetch bridge
would give an actual `[]`.

## Deployment
Deployed with `clasp` (set up 2026-09-25): `.clasp.json` holds the bound script's ID and
`.claspignore` limits uploads to `Code.gs`, `Employee.html`, `Admin.html`, `appsscript.json`. Run as the
owner account (`clasp --user owner …` on the owner's PC): `push --force`, then
`deploy -i <existing deployment ID>` so the live `/exec` URL is updated in place (see resume.md's
Deploy checklist for the exact commands). Pushing alone, like clicking Save in the online editor,
does *not* update the live `/exec` URL; a new version must be deployed. Manual paste + Manage
deployments → New version still works as a fallback.

The Hold auto-reject feature additionally requires a **one-time manual trigger install** that
paste-and-redeploy alone can't do: Apps Script editor → Triggers page (clock icon) → Add Trigger →
function `autoRejectExpiredHolds_` → Time-driven → Minutes timer → every 15 minutes → Save. Persists
across future redeploys as long as the function name doesn't change.

## Conventions
- Every `_`-suffixed function (e.g. `getRequestsSheet_`, `isValidEmployee_`) is an internal helper,
  never called directly from the client. Everything without the suffix is part of the public
  surface reachable via `google.script.run` / the `doPost` whitelist — keep that distinction when
  adding functions.
- `REQUEST_HEADERS` in `Code.gs` is rewritten into row 1 on every load — if you rename a column,
  change it there (and the matching `COL` index), not by hand-editing the sheet header cell.
