# Build Prompt: Cash Advance (CA) Portal — Photoline

## Context
Photoline is a Philippine retail company with ~100 employees across branches. HR (me) already runs a workforce management ecosystem on **Google Sheets + Google Apps Script** (free tier, client-side computation, no paid backend). This new CA Portal should follow the same stack and stay consistent with that ecosystem.

There is already an **existing Google Sheet** that stores Cash Advance (CA) request responses (from a prior Google Form). Reuse this sheet as the database — do not create a new one. I will provide the actual Sheet ID/link and current column layout before you wire up the backend; ask me for it if it's missing.

## Goal
Build a web-based CA Request Portal that replaces the manual process, with:
1. Employee CA request submission
2. Field-level validation
3. Two-step review: **Processor** (initial validation) → **Approver** (ATD compliance check)
4. Auto-forward of approved requests to HR
5. Auto-generated HR summary table for disbursement

## Roles & Permissions
| Role | Access |
|---|---|
| **Employee** | Submit CA requests, view own request status |
| **Processor** | View pending requests, validate completeness/entries and Days Present, forward to Approver |
| **Approver** | View processor-validated requests, mark ATD compliance (per auditor verification), approve/reject |
| **HR** | View-only on approved requests, generate/export disbursement summary |

## Workflow
```
Employee submits CA request
        ↓
[VALIDATION] required fields, valid amount, no duplicate pending request, Days Present populated
        ↓
Processor reviews → complete & correct? → forwards to Approver
        ↓
Approver reviews → ATD compliant (per auditor)? → Approve / Reject
        ↓
   REJECTED → back to employee with reason
   APPROVED → forwarded to HR → appears in HR Summary (ready for disbursement)
```

## Request Fields
- Employee Name
- Amount
- Purpose
- Date Needed
- **Cutoff Period** — `26-10` or `1-25`
- **Days Present (this cutoff)** — Total Days for that cutoff, same basis as existing BioCalc Total Days workflow (pull automatically from attendance data if a matching sheet/tab is available; otherwise allow manual entry for now)

## Google Sheet Columns (extend existing sheet)
`Timestamp | Employee Name | Amount | Purpose | Date Needed | Cutoff Period | Days Present | Status | Processor Remarks | ATD Compliance (Yes/No) | Approver Remarks | Date Approved | Forwarded to HR (Yes/No)`

`Status` values: `Pending` → `Processing` → `Approved` / `Rejected`

## Tech Stack
- **Frontend:** HTML + CSS + vanilla JavaScript (no framework), mobile-responsive
- **Backend:** Google Apps Script Web App (`doGet` / `doPost`) bound to the existing Google Sheet
- No paid services, no new database

## Frontend Pages
1. **Request Form** — employee submits a new CA request
2. **My Requests** — employee's own status tracker (Pending / Processing / Approved / Rejected)
3. **Processor Dashboard** — pending requests queue, validation actions
4. **Approver Dashboard** — processor-cleared requests, ATD compliance field, approve/reject actions
5. **HR Summary View** — auto-filtered table of Approved requests, exportable, disbursement-ready

## Backend (Apps Script) Functions Needed
- `doGet` / `doPost` — Web App entry points reading/writing the Sheet
- Validation function — required fields, valid amount, duplicate-active-request check, Days Present presence
- Status transition function — Pending → Processing → Approved/Rejected
- Days Present lookup — pull from BioCalc-style Total Days data if a matching sheet/tab exists
- HR summary generator — filters rows where `Status = Approved`

## Frontend Design Direction (apply the frontend-design skill — no generic/templated UI)
**Concept:** "Ledger" — evokes a traditional payroll/cash-advance ledger book with a stamped-approval feel, fitting for a Philippine retail HR tool.

**Palette:**
- Ledger Ink Navy `#1F2D3D` — headers, text, primary UI
- Warm Paper `#EDEAE2` — background
- Forest Green `#3B6255` — approved status
- Stamp Red `#A63D33` — rejected/urgent
- Gold Amber `#C08A2E` — pending/highlight
- Slate `#5B6570` — secondary text

**Typography:**
- Display/headers: sturdy slab serif
- Body: clean sans-serif (dashboard-legible, e.g. Inter)
- Numbers/amounts/IDs: monospace, tabular figures

**Layout:**
- Request form styled like a ledger card / carbon-copy receipt
- Processor/Approver dashboards styled as ledger table rows
- **Signature element:** status badges (Pending/Approved/Rejected) rendered as **stamp-style badges** — slight rotation, ink-stamp texture — instead of generic colored pill badges

Fully responsive down to mobile (field staff may use phones).

## Build Instructions
1. Set up the Apps Script project bound to the existing CA Sheet (ask me for the Sheet ID if not provided).
2. Build the five frontend pages above as a single-page app or simple multi-page HTML set, following the Ledger design direction.
3. Implement validation, the two-step review flow, and the auto-generated HR summary exactly as specified.
4. Keep computation client-side / within Apps Script's free tier — no paid infrastructure.
5. Flag any open questions (e.g. minimum Days Present eligibility rule) instead of assuming — check with me first.
