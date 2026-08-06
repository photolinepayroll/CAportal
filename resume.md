# Resume Notes — CA Portal

Last updated: 2026-08-07. Read `CLAUDE.md` first for how the system works; this file is about
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
- **Pending deploy**: everything through item 18 above (Approver-Hold/Authorizer-batch feature plus
  the follow-up UI polish) is committed and pushed to GitHub as of commit `36164a3`, but had not yet
  been pasted into the Apps Script editor as of this session. `Code.gs` and `Admin.html` **must**
  deploy together — they share the renamed `getApproverQueue`/`getForAuthorization`/`authorizeBatch`
  function names and the `hr`→`authorizer` role rename; deploying only one half breaks the
  Approver/Authorizer tabs entirely. (Item 18's changes are `Admin.html`-only, but since `Code.gs`
  from item 17 still isn't live either, both files still need to go up together in one pass.) Two
  extra one-time manual steps beyond the usual paste-and-redeploy, both required immediately after
  deploying (see `CLAUDE.md`'s Deployment section for exact steps):
  1. **Roles sheet fix**: change every existing `hr` row to `authorizer` in the `Roles` tab, or that
     account gets locked out the instant the new code goes live.
  2. **Install the time-driven trigger**: Apps Script editor → Triggers → Add Trigger →
     `autoRejectExpiredHolds_` → Time-driven → every 15 minutes → Save. Without this, Hold requests
     will never auto-reject (everything else works fine either way).

## Deploy checklist after pulling changes from this repo
1. Open the bound Sheet → Extensions → Apps Script.
2. Paste `Code.gs`, `Employee.html`, `Admin.html`, `appsscript.json` contents into the matching
   files in the editor (create new files there if they don't exist yet — see `CLAUDE.md` for the
   full file list).
3. Deploy → Manage deployments → pencil icon → **New version** → Deploy. Saving in the editor
   alone does *not* update the live URL.
4. If only testing frontend/JS changes (not `Code.gs`), you can skip steps 2–3 for those files and
   just open `Employee.html`/`Admin.html` locally — the `LOCAL_WEB_APP_URL` bridge hits the
   already-deployed backend directly.
