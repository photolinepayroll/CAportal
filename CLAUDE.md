# CA Portal — Photoline Cash Advance Chatbot

## What this is
Employee-facing chatbot + staff review dashboard for Cash Advance (CA) requests at Photoline, a
Philippine retail company. Replaces a manual Google Form + spreadsheet process with a two-step
review workflow (Processor → Approver → HR disbursement) on top of the same Google Sheet.

Sibling project: `photolinepayroll/payslip-chatbot` — same architecture pattern (single-file HTML,
Google Sheet backend, Apps Script security boundary), and this project's Employee-facing UI was
deliberately restyled to match its Messenger-style look (Facebook blue `#1877F2`, message bubbles,
quick-reply buttons) instead of a generic form.

## Stack
No build step, no npm, no framework. Google Apps Script Web App bound to a Google Sheet.
- **Backend:** `Code.gs` — one file, all server functions.
- **Frontend:** `Employee.html` (public, no login) and `Admin.html` (PIN-gated), each fully
  self-contained (inline `<style>`/`<script>`, no includes) so they're easy to paste whole into
  the Apps Script editor.
- **Manifest:** `appsscript.json` — `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`. The
  script always runs as the deploying owner regardless of who's visiting, which is why the
  underlying Sheet itself never needs to be shared publicly — only the web app URL is public.

## Routing
`doGet(e)` serves `Employee.html` by default, or `Admin.html` when `?page=admin` is in the URL.
Same deployed URL for both; the query param is the only difference.

## Data model (single Google Sheet, ID hardcoded as `SHEET_ID` in Code.gs)
- **`Form Responses 1`** (`REQUESTS_TAB`) — the actual CA requests. Columns A–F are legacy
  (from the original Google Form) and are left alone; columns G onward were added by this project.
  `ensureRequestHeaders_()` rewrites the header row on every `doGet` so it's always self-healing.
  `COL` in `Code.gs` is the single source of truth for column positions.
- **`Roles`** — `Role | Name | PIN`. Auto-created with placeholder rows on first load. Gates the
  Processor/Approver/HR views in `Admin.html` (see Security below).
- **`Masterlist`** — `Last Name | First Name | Middle Name | Date of Birth` in columns A–D, plus
  a `Branches` reference list in column F (unrelated to the row it sits next to — just a flat
  list used to populate the searchable branch dropdown via `getBranchList()`). This is the
  identity whitelist requests are verified against before any CA details are even asked.
- **`Settings`** — generic `Key | Value` store. Currently holds `CA_WINDOW_OVERRIDE`
  (`AUTO`/`FORCE_OPEN`/`FORCE_CLOSED`) and `LAST_SCA_SEQUENCE` (the running counter for request IDs).

## Business rules encoded in Code.gs (not just UI validation — every rule is re-checked
server-side inside `createRequest`/`validateNewRequest_`, since `Employee.html` is unauthenticated
and its client-side checks are just UX, not security)
- **CA amount**: fixed enum, `CA_AMOUNTS = [500, 1000, 1500, 2000]`. No free-text amounts.
- **CA window**: normally open Monday–Wednesday only (`isCaWindowOpen_`, Asia/Manila). HR can
  force it open or closed from `Admin.html`'s HR view regardless of day, for emergencies.
- **Cutoff period**: auto-computed from today's day-of-month, never asked — 11th–25th ⇒ `11-25`,
  else ⇒ `26-10` (`computeCutoffPeriod_`).
- **Crediting date**: auto-computed as the next Friday on/after submission day, never asked
  (`computeCreditingDate_`) — never rolls into the past even if HR force-opens the window outside
  the normal schedule.
- **Identity verification**: before any CA question is even asked, the chatbot collects Last Name,
  First Name, Middle Name (or "None"), and Birthday, and calls `verifyIdentity()` — all four must
  match one row in `Masterlist`. Only then does it proceed to the actual CA questions. Middle name
  gets folded into the stored `Name` cell as "Last, First Middle" (Proper Case auto-applied via
  `toProperCase_`); there's no separate Middle Name column.
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
- Processor/Approver/HR actions all call `requireRole_(role, pin)` server-side — cannot be
  bypassed from the client.
- **Known open risk, not yet mitigated**: no rate-limiting/lockout on PIN attempts
  (`verifyPin_`/`checkPin`). A 4-digit PIN is brute-forceable given enough requests. Flagged to
  the project owner; add attempt throttling (e.g. a cooldown keyed in `Settings`) if this becomes
  a real concern.

## Local development / testing without redeploying
Both `Employee.html` and `Admin.html` have a `gs()` wrapper that detects whether
`google.script.run` exists. When it doesn't (i.e. the file was opened directly instead of served
by Apps Script), it falls back to `fetch()`-ing `window.LOCAL_WEB_APP_URL` (set near the top of
each file) with `{fn, args}` as a `text/plain` POST body — `doPost` in `Code.gs` is the receiving
end of that bridge. This means you can iterate on the HTML/CSS/JS locally against the **real live
Sheet** without touching the Apps Script editor for every tweak; you only need to paste-and-deploy
when `Code.gs` itself changes.

## Deployment
No `clasp` set up — deploy by pasting file contents into the Apps Script editor (bound to the
Sheet via Extensions → Apps Script) and creating a **New version** under Manage deployments.
Editing files in the online editor and clicking Save does *not* update the live `/exec` URL by
itself; a new version must be deployed.

## Conventions
- Every `_`-suffixed function (e.g. `getRequestsSheet_`, `isValidEmployee_`) is an internal helper,
  never called directly from the client. Everything without the suffix is part of the public
  surface reachable via `google.script.run` / the `doPost` whitelist — keep that distinction when
  adding functions.
- `REQUEST_HEADERS` in `Code.gs` is rewritten into row 1 on every load — if you rename a column,
  change it there (and the matching `COL` index), not by hand-editing the sheet header cell.
