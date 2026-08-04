# Resume Notes — CA Portal

Last updated: 2026-08-05. Read `CLAUDE.md` first for how the system works; this file is about
**where things stand** and **what's left to do**.

## Current state
Fully built and functional as a Messenger-style chatbot (Employee.html) + PIN-gated staff
dashboard (Admin.html), backed by one Google Sheet (`SHEET_ID` in `Code.gs`). Deployed as an Apps
Script Web App. The owner has been testing it live and iterating on real feedback.

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

## Open items / not yet done
- **PIN brute-force protection**: flagged to the owner, not yet implemented. `verifyPin_` has no
  rate limiting — a 4-digit PIN is guessable given enough attempts. Owner hadn't responded on
  whether/how to fix this as of the last session (options: attempt counter + cooldown in
  `Settings`, longer PINs, etc.) — ask before implementing, don't just do it silently since it
  changes the UX (staff could get locked out).
- **Masterlist data population**: the owner is filling this in manually in the Sheet
  (Last Name/First Name/Middle Name/Date of Birth + the Branches reference list in column F).
  Verify it's populated before assuming identity verification will pass for real employees.
- **Roles tab PINs**: seeded with placeholders (`PLACEHOLDER` / `0000`) on first load — confirm
  the owner has replaced these with real names/PINs before wide rollout.
- No automated tests exist (Apps Script has no local test runner in this setup) — verification has
  been entirely manual, walking the chat flow end-to-end after each change. See the Verification
  section pattern in past plans for what to click through.

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
