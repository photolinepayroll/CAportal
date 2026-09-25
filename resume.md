# Resume Notes — CA Portal

Last updated: 2026-09-25 (cutoff-window fix, Masterlist verification fixes, Processor status filter). Read `CLAUDE.md` first for how the system works; this file is about
**where things stand** and **what's left to do**.

## Current state
Fully built and functional as a Messenger-style chatbot (Employee.html) + real username/password
login staff dashboard (Admin.html) with role-based access control, backed by one Google Sheet
(`SHEET_ID` in `Code.gs`). Deployed as an Apps Script Web App. The owner has been testing it live
and iterating on real feedback.

## Build history (roughly in order)
1. Initial "Ledger" design (navy/warm-paper, stamp-style status badges) — form-based UI, 5 tabs
   in one page. Superseded.
2. Split into two pages: `Employee.html` (Request Form + My Requests) and `Admin.html`
   (Processor/Approver/HR), routed via `?page=admin`. PIN-gating added for the three staff roles.
3. Added a `LOCAL_WEB_APP_URL` fetch-bridge so the HTML files can be opened locally and still hit
   the live backend, for faster iteration without redeploying every time.
4. Redesigned `Employee.html` entirely as a chatbot (matching the sibling `payslip-chatbot`
   repo's style/workflow) — greeting → quick-reply menu → step-by-step conversation instead of a
   static form. Tabs removed for the employee side.
5. Added real business rules: `Masterlist` identity whitelist, fixed CA amounts, Mon–Wed CA
   window with HR override, auto-computed crediting date (next Friday) and cutoff period
   (11–25 vs 26–10 by day-of-month).
6. Hardened identity verification into a "verify first, then ask CA details" two-phase flow:
   Last Name + First Name + Middle Name + Birthday must match `Masterlist` before any CA question
   is even shown. Branch is NOT part of identity (no branch column in Masterlist) — it's just a
   per-request field, now a searchable dropdown sourced from `Masterlist` column F.
7. Switched Request ID from a raw UUID to sequential `SCA#000001`-style numbers, generated inside
   a `LockService` lock so concurrent submissions can't collide.
8. Closed a security gap: "My Requests" used to accept a bare name (or even fuzzy word-match) and
   would show anyone's CA history to anyone who guessed their name. Now requires **Last Name +
   SCA# together** — the SCA# is only ever shown to the person who submitted that request.
9. Replaced the per-tab 4-digit PIN system in `Admin.html` with a real `login(username, password)`
   screen. `Roles` sheet schema changed from `Role | PIN` to `Username | Password | Role | Name`.
   Added an `admin` role with all-access. Every protected server function now calls
   `requireAccess_(username, password, requiredRole)`, re-validating credentials on every call
   (stateless); the client caches the verified session in `sessionStorage` after login so the user
   isn't retyping credentials on every click. Landing/auth gate no longer auto-prompts on page
   load (fixed before the login rework, still holds).
10. Moved the Admin.html logout affordance from a small footer text link to a proper button in the
    header, next to the date label — only shown once authenticated.
11. Added a live name filter and batch approve/reject to both the Processor and Approver queues in
    `Admin.html`, matching the owner's separate `attendance-app` admin dashboard's UX. New
    `processorReviewBatch`/`approverReviewBatch` in `Code.gs` validate access once, read the sheet
    once, and collect per-row failures (e.g. a request already actioned by someone else) instead of
    aborting the whole batch — see `reportBatchResult()` in `Admin.html` for how that's surfaced to
    staff. Approver's batch-approve uses one shared ATD-compliant checkbox + one shared remarks box
    applied to every selected request; batch-reject (either queue) uses one shared remarks box.
    Single-row actions are untouched.
12. Added a "Filter by branch" dropdown alongside the name filter in both the Processor and
    Approver queues — combines with the name filter (both must match). Options are built from
    whichever branches actually appear in the currently-loaded queue (not the full Masterlist), so
    the dropdown never offers a branch with zero pending requests.
13. Gave the Processor the ability to correct a request's CA amount as part of the existing
    single-row Forward action (not batch, not Reject) — a dropdown constrained to the same
    `CA_AMOUNTS` enum, pre-selected to the current amount. `processorReview` gained a `newAmount`
    parameter, re-validated server-side, and auto-prepends an audit note to `PROCESSOR_REMARKS`
    when the amount actually changes ("Amount corrected from ₱X to ₱Y."). Built via the full
    brainstorming → spec → plan → subagent-driven-implementation workflow — see
    `docs/superpowers/specs/2026-08-05-processor-amount-edit-design.md` and
    `docs/superpowers/plans/2026-08-05-processor-amount-edit.md` for the full design record.
14. Translated all employee-facing chatbot copy in `Employee.html` from Tagalog to English
    (comprehensive pass — greeting, quick replies, prompts, error/validation messages).
15. Added an "Export PDF" action to the HR Disbursement Summary in `Admin.html` — HR can print
    the approved-requests table (total amount, ATD compliance status) with three signature lines
    (Prepared by pre-filled with the logged-in user, Reviewed by / Approved by left blank) via the
    browser's native Print dialog (`window.print()` + `@media print` CSS). Frontend-only, no
    `Code.gs` changes.
16. Added a `CacheService`-backed caching layer to `Code.gs` to cut redundant Sheet reads on hot
    paths: `Settings`, `Masterlist`, `Roles`, and `getAllRequests_()` are now wrapped with
    `cacheGetOrSet_()` (TTLs 5–30 min depending on how often each sheet changes), invalidated
    explicitly at the end of all five write paths (`createRequest`, `processorReview`,
    `approverReview`, `processorReviewBatch`, `approverReviewBatch`). Also guarded
    `ensureRequestHeaders_()` to skip its header-row write on `doGet()` when the header already
    matches, instead of rewriting unconditionally on every page load.
17. Added an Approver `Hold` status with a Wednesday-11am auto-reject deadline, and turned the
    passive "HR Disbursement Summary" tab into an active **Authorizer** tab that batch-disburses
    approved requests under a new sequential transaction number, plus a Transaction History view.
    Full details:
    - `STATUS` gained `HOLD`/`DISBURSED`. `approverReview`/`approverReviewBatch` now accept a
      `'hold'` action (Processing → Hold, no ATD/remarks required) and both accept Processing **or**
      Hold as the valid starting status for approve/reject.
    - `autoRejectExpiredHolds_()` — a new time-driven trigger function (installed manually in the
      Apps Script editor's Triggers page, **not** deployable via file paste, see below) — sweeps any
      request still on `Hold` past `computeHoldDeadline_()` (11:00 AM Manila on the current week's
      Wednesday, recomputed fresh every run, independent of `CA_WINDOW_OVERRIDE`) and auto-rejects it
      with an audit-trail remark prefix.
    - `ROLES.HR` (`'hr'`) fully renamed to `ROLES.AUTHORIZER` (`'authorizer'`) throughout `Code.gs`
      and `Admin.html` (nav tab, panel id, `viewLoaders` key, `firstAllowed` array, seed account) —
      **existing `Roles` sheet rows saying `hr` need a one-time manual edit to `authorizer`,
      otherwise those accounts get locked out the moment the new code goes live.**
    - `getPendingForApprover` → `getApproverQueue`: now returns Processing + Hold + Approved +
      Approver-stage-Rejected rows (the last one discriminated by non-empty `APPROVER_REMARKS`, since
      that column is only ever written by Approver actions — reliably excludes Processor-stage
      rejects). The Approver tab gained a status filter (`For Approval`/`Hold`/`Approved`/`Rejected`);
      the latter two render read-only (no checkboxes, no Review button).
    - `generateHrSummary` → `getForAuthorization` (same Approved-status query, renamed role check).
      New `authorizeBatch(requestIds, username, password)`: select rows in the Authorizer tab, click
      "Authorize Selected" (native `window.confirm` guard, no remarks/ATD fields — true one-click),
      and every selected row gets stamped with one shared new `TXN#000001`-style batch id (new
      `getNextBatchSequence_`/`formatBatchId_`, mirroring the `SCA#` pattern, under the same
      `LockService` lock), a `DATE_AUTHORIZED` timestamp, and `AUTHORIZED_BY` staff name, then flips
      to `Disbursed` — which is what makes it vanish from the "For Authorization" list.
    - New `getTransactionHistory` groups all requests with a `TRANSACTION_BATCH_NO` by that column
      into past-batch summaries (newest first), rendered as a clickable-row table in the Authorizer
      tab's Transaction History sub-view; expanding a batch shows its individual requests and an
      "Export PDF" button scoped to just that batch (`buildBatchPrintHtml_`, reusing the exact
      `window.print()` + hidden `#pdf-print-area` pattern from the existing PDF export).
    - New `COL`/`REQUEST_HEADERS` entries (appended, not inserted): `TRANSACTION_BATCH_NO` (18),
      `DATE_AUTHORIZED` (19), `AUTHORIZED_BY` (20) — self-heal into the sheet via
      `ensureRequestHeaders_()` on the next `doGet`, no manual sheet-column setup needed.
    - Full design record: `C:\Users\Gilbert\.claude\plans\addition-heres-the-plan-concurrent-fog.md`.
18. Post-deploy UI polish on the Authorizer tab, driven by owner feedback after testing the live
    dashboard (all `Admin.html`-only, no `Code.gs` changes in this batch):
    - Moved "Authorize Selected" out of its own separate row into the main
      Refresh/Export CSV/Export PDF toolbar row.
    - Gave the toolbar a clearer visual hierarchy: "For Authorization"/"Transaction History" are now
      a real joined segmented control (`.segmented-control`, shared border, no gap) instead of two
      plain buttons; Refresh/Export CSV/Export PDF became a light outlined utility cluster on the
      left, with Authorize Selected standing alone as the one filled/green action on the right
      (`.toolbar-row`/`.toolbar-actions`).
    - Transaction History gained its own Refresh button (previously had no toolbar at all); each
      expanded batch preview gained an Export CSV button (`exportBatchCsv_`) next to the existing
      Export PDF, plus a `.summary-total` line ("Total: ₱X across N request(s)") shown before both
      export buttons so the totals are visible pre-export, not just baked into the PDF.
    - Both PDF exports (`buildForAuthorizationPrintHtml_`, `buildBatchPrintHtml_`) retitled to a
      single shared "Cash Advance Disbursement", and the "Prepared by" signatory line no longer
      auto-fills the logged-in staff member's name (blank now, matching Reviewed by/Approved by).
      The per-batch export's transaction number moved from the (now-generic) title into its meta
      subtitle line so it's still on the printed record.
    - Clicking "Authorize Selected" now shows a spinner + "Authorizing…" on the button and dims the
      table with a pulsing "Processing…" overlay while the batch call is in flight
      (`.btn-spinner`/`.table-scroll.is-processing`), so a large batch doesn't feel like a dead click.
    - The "N selected" label next to Authorize Selected now also shows the peso total of just the
      selected rows (not the whole list), computed client-side from `authForRowsCache`.
19. Added `.nojekyll` to repo root so GitHub Pages serves the static mirror as plain files instead
    of running it through Jekyll (which can stall/break the Pages build for a non-Jekyll site).
    Infra-only, no app code changes.
20. Fixed the Approver queue in `Admin.html`: the status/name/branch filter row (and the status
    filter itself) used to be hidden entirely whenever zero rows matched across all
    approver-relevant statuses combined, which trapped staff on an empty "For Approval" view with
    no way to switch to `Approved`/`Rejected`/`Hold` to check history. `renderApproverQueue` now
    always renders the filter chrome; only the table body is conditionally empty.
21. Changed how the Cutoff Period is *displayed* (owner reported the raw `26-10`/`11-25` codes were
    confusing). New `formatCutoffPeriodLabel_()` in `Code.gs` turns the stored code into an actual
    month/day range for the request's own submission date, e.g. "Aug 11 - Aug 25" or
    "Aug 26 - Sep 10" — exposed as a new `cutoffPeriodLabel` field alongside the existing raw
    `cutoffPeriod` on every request object (`rowToRequestObject_`, `createRequest`'s return value).
    The raw sheet column/value is untouched (still `26-10`/`11-25`, still the source of truth) —
    only the UI-facing label changed, in `Employee.html` (chat review card, submission confirmation,
    My Requests lookup, plus a client-side `computeCutoffPeriodPreview()` mirror matching the new
    format) and `Admin.html` (all queue/history tables, CSV exports, and PDF exports across
    Processor/Approver/Authorizer). Not yet deployed — see Pending deploy below.
22. Hardened the `gs()` fetch bridge (`Employee.html`/`Admin.html`, used when opened locally or on
    GitHub Pages instead of via `google.script.run`) against several real-world failure modes hit
    during live/GitHub Pages testing — five commits, frontend-only, no `Code.gs` changes:
    - Retry once on an HTML-interstitial response (idle Apps Script instance / transient auth
      hiccup returning HTML instead of JSON) instead of surfacing a raw "Unexpected token '<'" error.
    - Guarded six call sites against `google.script.run`'s quirk of delivering an empty array as
      `null` (only affects the direct `/exec` link, not the fetch bridge) — was crashing empty-state
      cases (no matching status lookup, empty queues) with a `.length`-of-null error.
    - Bounded each `gs()` attempt with a 45s `AbortController` timeout so a slow/stuck Apps Script
      response fails fast with a clear message instead of hanging for minutes; `Employee.html`'s
      typing indicator also shows a "still working" note past 6s so a slow reply doesn't look frozen.
    - Generalized the retry to cover raw network failures (`Failed to fetch`), not just bad-HTML
      responses, since these are expected to become more common as concurrent usage grows.
    - Restricted auto-retry to read-only calls only: for write functions (`createRequest`,
      `processorReview`, `approverReview`, both batch variants, `authorizeBatch`,
      `setCaWindowOverride`) a network failure/timeout is ambiguous about whether the write already
      landed server-side, so auto-retrying risked a duplicate request/review/disbursement — writes
      still retry only the provably-safe HTML-interstitial case, and surface once otherwise. Not yet
      deployed — see Pending deploy below.
23. Added Export CSV / Export PDF to the Processor Queue tab (`Admin.html`, frontend-only, no
    `Code.gs` changes) — the only staff tab that had neither before this. Purpose is a printable
    pre-decision review sheet, not an audit record, so it's shaped differently from the existing
    Authorizer export: every row (CSV and PDF alike) carries an intentionally blank **Remarks**
    column for a processor to hand-annotate while reviewing away from the screen, and the PDF footer
    has two blank signatory lines, "Prepared by" / "Checked by" (vs. the Authorizer PDF's three),
    reusing the existing `buildSignatoryBlock_` helper. Both exports respect whatever the
    name/branch filter row currently has visible (tracked in a new `procVisibleRows` var, set at the
    top of `renderProcessorTable`), not the full unfiltered queue — mirrors the Authorizer export's
    `authForRowsCache` pattern but filter-aware. New `exportProcessorCsv_`/`exportProcessorPdf_`/
    `buildProcessorPrintHtml_` functions reuse the shared `toCsvValue`/`buildSignatoryBlock_`/
    `#pdf-print-area` plumbing — no new CSS. Not yet deployed — see Pending deploy below.
24. Added a "one successful CA per cutoff period" rule to `validateNewRequest_` (`Code.gs`) —
    previously an employee was only blocked while they had an *open* request (Pending/Processing/
    Hold); now they're also blocked if they already have an `Approved` or `Disbursed` request whose
    `cutoffPeriod` matches `computeCutoffPeriod_()`'s result for today. A `Rejected` request doesn't
    count, so a rejected employee can still retry within the same cutoff period. Self-refreshing by
    design: the check re-derives "current cutoff period" from today's date on every call, so once the
    calendar rolls into the next cutoff period (26-10 ↔ 11-25) the old request's period code no
    longer matches and the employee can submit again — no separate reset logic needed. Backend-only
    change (`Code.gs`), needs the usual paste-and-redeploy — see Pending deploy below.
    **Superseded by item 25**: comparing the raw code turned out to be a bug (see below).
25. Fixed item 24's rule permanently blocking employees: the raw `26-10`/`11-25` code repeats every
    month, so an Approved request from *last* month's `11-25` window still matched *this* month's
    `11-25` and never refreshed. New `computeCutoffWindow_(refDate)` returns the actual `{start, end}`
    calendar dates (with year, handling the Dec 26 – Jan 10 rollover) of the current window, and
    `validateNewRequest_` now checks each past request's own `timestamp` against those dates instead
    of comparing codes. Backend-only (`Code.gs`). CLAUDE.md updated to match.
26. Fixed newly-added employees failing identity verification (two commits, `Code.gs` only):
    - `isValidEmployee_` no longer reads `Masterlist` through the 15-minute script cache, where a row
      hand-added to the sheet could fail verification until the cache expired. It reads the sheet
      directly now (same as `getBranchList()`).
    - Names are normalized before matching: all whitespace variants (e.g. non-breaking spaces from
      Word/Excel/PDF copy-paste) collapse to one space and zero-width chars are stripped, so a row
      that *looks* right but contains invisible characters still matches.
    - Note: the unmerged branch `claude/dazzling-mendel-71yv9k` tried an alternate fix (an `onEdit`
      trigger busting the Masterlist/Roles/Settings cache). Main's direct-read approach supersedes it
      for Masterlist; that branch was not merged.
27. Added a status filter to the Processor Queue (`Admin.html` + `Code.gs`), mirroring the Approver
    tab: **Pending** (default, actionable), **Forwarded** (past the Processor stage, including
    Approver-rejected), **Rejected** (rejected by the Processor, i.e. empty `APPROVER_REMARKS`).
    Forwarded/Rejected are read-only with Status and Processor Remarks columns. New backend
    `getProcessorQueue` returns every request for client-side bucketing (`procStatusBucket_`); the
    filter row always shows, even with nothing pending. Processor exports respect the status filter
    too. `Code.gs` and `Admin.html` must deploy together for this one (new function name).
28. Closed the CA window on payroll dates (owner request, 2026-09-25): under `AUTO` the window is
    now closed on the 11th–15th and the 26th–end of month **even if that day is Mon–Wed**
    (`CA_PAYROLL_BLACKOUT_RANGES` in `Code.gs`). The logic moved into a new
    `getCaWindowState_(refDate)` → `{open, reason}` helper; `isCaWindowOpen_` wraps it, and
    `getCaWindowStatus()` now also returns `reason` (`'payroll'`/`'day'`/`'forced'`). Force Open
    still overrides both rules (owner's choice). `Employee.html` shows a payroll-specific closed
    message, and `Admin.html`'s Authorizer panel shows "CLOSED (payroll dates)" and relabels Auto as
    "Auto (Mon–Wed, excl. payroll dates)". The server-side closed error in `validateNewRequest_` was
    still in Tagalog and is now English and mentions both rules. Checked with a Node harness over
    sample dates (payroll Mon/Tue, short-month Feb 26, Thu, override cases).

## Open items / not yet done
- **Login brute-force protection**: flagged to the owner, not yet implemented. `findUser_`/`login`
  has no rate limiting or lockout — credentials are guessable given enough attempts. Owner hadn't
  responded on whether/how to fix this as of the last session (options: attempt counter + cooldown
  keyed in `Settings`, etc.) — ask before implementing, don't just do it silently since it changes
  the UX (staff could get locked out).
- **Masterlist data population**: the owner is filling this in manually in the Sheet
  (Last Name/First Name/Middle Name/Date of Birth + the Branches reference list in column F).
  Verify it's populated before assuming identity verification will pass for real employees.
- **Roles tab accounts**: seeded with placeholder username/password on first load — confirm the
  owner has replaced these with real staff accounts before wide rollout.
- No automated tests exist (Apps Script has no local test runner in this setup) — verification has
  been entirely manual, walking the chat flow end-to-end after each change. See the Verification
  section pattern in past plans for what to click through.
- **Deployed 2026-09-25 (version @35)**: everything through item 28 is live on the existing
  `/exec` URL (deployment `AKfycbwdC3…`), pushed and deployed via clasp from commit `4a558db` as the
  owner account `photoline.payroll@gmail.com`. Before this, the live editor had `Code.gs` from
  `d2c9fec` but `Employee.html`/`Admin.html` from Aug 19 (`7daeb51`). Verified live:
  `getCaWindowStatus` returns the new `reason` field. **Still manual, owner to confirm done:**
  1. **Roles sheet fix**: change every existing `hr` row to `authorizer` in the `Roles` tab, or that
     account is locked out now that the new code is live.
  2. **Install the time-driven trigger**: Apps Script editor → Triggers → Add Trigger →
     `autoRejectExpiredHolds_` → Time-driven → every 15 minutes → Save. Without this, Hold requests
     never auto-reject (everything else works fine either way).

## Deploy checklist (clasp, set up 2026-09-25)
`.clasp.json` (script ID) and `.claspignore` (only `Code.gs`, `Employee.html`, `Admin.html`,
`appsscript.json` get uploaded) are in the repo root. clasp is logged in on this PC under the named
user `owner` (= `photoline.payroll@gmail.com`, the Sheet/script owner; the default clasp user is
`photoline.payroll20@gmail.com`, an editor). Deploy as the owner, since `executeAs: USER_DEPLOYING`.
1. `clasp --user owner status` — confirm only those four files are listed.
2. `clasp --user owner push --force` — uploads to the editor (not live yet).
3. `clasp --user owner deploy -i AKfycbwdC3QF0TpRtcoHB1bTNtSHEQsgE8nR1RXUwOm95hddzON8HFObLxeRNz-XEr6MJ2IEyQ -d "<note>"`
   — new version on the **existing** deployment, so the `/exec` URL stays the same. Don't run
   `clasp deploy` without `-i`, that creates a second URL.
4. Verify: POST `{"fn":"getCaWindowStatus","args":[]}` as `text/plain` to the `/exec` URL.
5. Frontend-only tweaks can still be tested locally first via the `LOCAL_WEB_APP_URL` bridge.
Manual paste into the editor + Manage deployments → New version still works as a fallback.
