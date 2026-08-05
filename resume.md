# Resume Notes — CA Portal

Last updated: 2026-08-05. Read `CLAUDE.md` first for how the system works; this file is about
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
- **Pending deploy**: as of this session, everything through commit `b6915e5` (logout button,
  name/branch filters, batch approve/reject, and the Processor amount-edit feature — all in
  `Admin.html` and/or `Code.gs`) is committed/pushed to GitHub but had not yet been pasted into the
  Apps Script editor + redeployed as a new version. `Code.gs` and `Admin.html` must be deployed
  **together** for the amount-edit feature specifically — they now depend on each other's updated
  `processorReview` signature (5 args → 6 args), so deploying only one half would break the
  Processor's Forward action entirely. Confirm deployment before assuming any of this is live for
  staff.

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
