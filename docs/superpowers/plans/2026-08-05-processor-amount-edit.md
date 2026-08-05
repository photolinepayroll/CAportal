# Processor: Edit CA Amount Before Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Processor correct a Pending CA request's amount (constrained to the same fixed enum used everywhere else: ₱500/₱1,000/₱1,500/₱2,000) as part of the existing Forward action, with an automatic audit note in Processor Remarks when the amount actually changes.

**Architecture:** `Code.gs`'s `processorReview` gains one new parameter (`newAmount`), applied and re-validated server-side only when `action === 'forward'`. `Admin.html`'s per-row Processor review panel gains an amount `<select>`, and its existing Confirm-button click handler passes the selected value through to the updated `gs('processorReview', ...)` call. No other function changes — `processorReviewBatch`, `approverReview`, `approverReviewBatch` are untouched.

**Tech Stack:** Google Apps Script (`Code.gs`), vanilla JS in a single `<script>` block (`Admin.html`), no build step, no automated test runner — verification is `node --check` for syntax plus a manual click-through against the live Apps Script backend (existing project convention, see `resume.md`).

**Spec:** `docs/superpowers/specs/2026-08-05-processor-amount-edit-design.md`

---

### Task 1: Backend — `processorReview` accepts and audits an amount correction

**Files:**
- Modify: `d:\CASH ADVANCE PORTAL\Code.gs:552-568`

- [ ] **Step 1: Replace `processorReview` with the amount-aware version**

Find this exact block (`Code.gs:552-568`):

```js
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
```

Replace it with:

```js
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
        'Amount corrected from \u20B1' + req.amount + ' to \u20B1' + amt + '.' +
        (finalRemarks ? ' ' + finalRemarks : '')
      ).trim();
    }
  }

  setRowFields_(req.rowIndex, fields);
  return { success: true };
}
```

Note: `\u20B1` is the ₱ peso sign — written as an escape here so the plan document itself stays
plain ASCII, but type the literal ₱ character in the actual file (matching the existing file's
`toast`/label strings elsewhere, e.g. `formatCurrency` in `Admin.html`), not the escape sequence.

- [ ] **Step 2: Verify Code.gs still has valid JS syntax**

Apps Script has no local test runner, so a syntax check is the available automated verification.
Copy the file to a `.js` extension and run Node's built-in checker:

```bash
cp "d:/CASH ADVANCE PORTAL/Code.gs" /tmp/Code_check.js && node --check /tmp/Code_check.js && echo "Code.gs: syntax OK"
```

Expected output: `Code.gs: syntax OK`

- [ ] **Step 3: Commit**

```bash
git add "Code.gs"
git commit -m "Let Processor correct CA amount when forwarding, with an audit note in remarks"
```

---

### Task 2: Frontend — amount dropdown in the Processor review panel

**Files:**
- Modify: `d:\CASH ADVANCE PORTAL\Admin.html:542-548` (add the `<select>` to the review panel HTML)
- Modify: `d:\CASH ADVANCE PORTAL\Admin.html:562-581` (pass the selected amount through to `gs('processorReview', ...)`)

- [ ] **Step 1: Add the amount `<select>` to the review-inline panel**

Find this exact block (`Admin.html:542-548`):

```js
            '<div class="review-inline" id="proc-inline-' + r.requestId + '">' +
              '<textarea placeholder="Remarks" id="proc-remarks-' + r.requestId + '"></textarea>' +
              '<div class="row-actions">' +
                '<button class="btn" data-confirm="forward" data-id="' + r.requestId + '">Confirm Forward</button>' +
                '<button class="btn btn-reject" data-confirm="reject" data-id="' + r.requestId + '">Confirm Reject</button>' +
                '<button class="btn btn-outline" data-confirm="cancel" data-id="' + r.requestId + '">Cancel</button>' +
              '</div>' +
            '</div>' +
```

Replace it with (adds a labeled amount dropdown, pre-selected to the request's current amount,
above the remarks textarea):

```js
            '<div class="review-inline" id="proc-inline-' + r.requestId + '">' +
              '<div class="field-group">' +
                '<label for="proc-amount-' + r.requestId + '">Amount (edit before forwarding if needed)</label>' +
                '<select id="proc-amount-' + r.requestId + '">' + buildAmountOptions_(r.amount) + '</select>' +
              '</div>' +
              '<textarea placeholder="Remarks" id="proc-remarks-' + r.requestId + '"></textarea>' +
              '<div class="row-actions">' +
                '<button class="btn" data-confirm="forward" data-id="' + r.requestId + '">Confirm Forward</button>' +
                '<button class="btn btn-reject" data-confirm="reject" data-id="' + r.requestId + '">Confirm Reject</button>' +
                '<button class="btn btn-outline" data-confirm="cancel" data-id="' + r.requestId + '">Cancel</button>' +
              '</div>' +
            '</div>' +
```

- [ ] **Step 2: Add the `buildAmountOptions_` helper**

This is the same fixed 4-value list Employee.html already presents to employees at request time
(`Employee.html:457`), so the dropdown never offers an amount outside the business rule.

Find the `getUniqueBranches_`/`buildBranchFilterOptions_` helpers (added in the earlier branch-filter
change, currently just above the `formatDate` function's later usages — search for
`function buildBranchFilterOptions_`). Add the new helper directly after `buildBranchFilterOptions_`
closes:

```js
    var CA_AMOUNTS = [500, 1000, 1500, 2000];

    /** Options for the Processor's amount-correction dropdown, pre-selecting the request's current amount. */
    function buildAmountOptions_(currentAmount) {
      var current = Number(currentAmount);
      var opts = '';
      CA_AMOUNTS.forEach(function (amt) {
        opts += '<option value="' + amt + '"' + (amt === current ? ' selected' : '') + '>' + formatCurrency(amt) + '</option>';
      });
      return opts;
    }
```

- [ ] **Step 3: Pass the selected amount through to `processorReview`**

Find this exact block (`Admin.html:562-581`):

```js
      area.querySelectorAll('[data-confirm]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.dataset.id;
          var action = btn.dataset.confirm;
          if (action === 'cancel') {
            document.getElementById('proc-inline-' + id).classList.remove('show');
            return;
          }
          var remarks = document.getElementById('proc-remarks-' + id).value.trim();
          if (action === 'reject' && !remarks) { toast('Remarks are required to reject.', 'error'); return; }
          btn.disabled = true;
          gs('processorReview', id, action, remarks, session.username, session.password).then(function () {
            toast(action === 'forward' ? 'Forwarded to Approver.' : 'Request rejected.', 'success');
            loadProcessorQueue(session);
          }).catch(function (err) {
            btn.disabled = false;
            toast(err && err.message ? err.message : String(err), 'error');
          });
        });
      });
```

Replace it with (reads the new select's value and inserts it as the new `newAmount` argument,
same position as the new server parameter):

```js
      area.querySelectorAll('[data-confirm]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.dataset.id;
          var action = btn.dataset.confirm;
          if (action === 'cancel') {
            document.getElementById('proc-inline-' + id).classList.remove('show');
            return;
          }
          var remarks = document.getElementById('proc-remarks-' + id).value.trim();
          var newAmount = document.getElementById('proc-amount-' + id).value;
          if (action === 'reject' && !remarks) { toast('Remarks are required to reject.', 'error'); return; }
          btn.disabled = true;
          gs('processorReview', id, action, remarks, newAmount, session.username, session.password).then(function () {
            toast(action === 'forward' ? 'Forwarded to Approver.' : 'Request rejected.', 'success');
            loadProcessorQueue(session);
          }).catch(function (err) {
            btn.disabled = false;
            toast(err && err.message ? err.message : String(err), 'error');
          });
        });
      });
```

- [ ] **Step 4: Verify Admin.html's script block still has valid JS syntax**

```powershell
$scratch = "C:\Users\Gilbert\AppData\Local\Temp\claude\d--CASH-ADVANCE-PORTAL\629c4d15-292e-4f74-b4c7-cc641f0c9bae\scratchpad"
$html = Get-Content "D:\CASH ADVANCE PORTAL\Admin.html" -Raw
$matches = [regex]::Matches($html, '(?s)<script>(.*?)</script>')
$matches[1].Groups[1].Value | Out-File -FilePath "$scratch\admin_main.js" -Encoding utf8
node --check "$scratch\admin_main.js"
if ($?) { Write-Output "Admin.html main script: syntax OK" }
```

Expected output: `Admin.html main script: syntax OK`

- [ ] **Step 5: Sanity-check the new IDs are wired consistently**

```bash
cd "d:/CASH ADVANCE PORTAL" && grep -n "proc-amount-" Admin.html
```

Expected: two matches — one building the `<select id="proc-amount-' + r.requestId + '">"` in the
row template, one reading `document.getElementById('proc-amount-' + id)` in the confirm handler.

- [ ] **Step 6: Commit**

```bash
git add "Admin.html"
git commit -m "Add amount dropdown to Processor's Forward panel"
```

---

### Task 3: Manual verification against the live app

**Files:** none (manual QA only — no automated test runner exists in this project)

- [ ] **Step 1: Deploy**

Paste the updated `Code.gs` and `Admin.html` into the Apps Script editor (Extensions → Apps Script
on the bound Sheet), then Deploy → Manage deployments → pencil icon → New version → Deploy. Saving
in the editor alone does not update the live `/exec` URL.

- [ ] **Step 2: Unchanged amount still forwards cleanly**

Open the Processor queue, click Forward on a Pending row (note its current amount, e.g. ₱1,000).
Leave the amount dropdown on its pre-selected value, leave remarks blank, click Confirm Forward.
Check the Google Sheet: `STATUS` = Processing, `AMOUNT` unchanged, `PROCESSOR_REMARKS` = `''` (no
audit note, since nothing changed).

- [ ] **Step 3: Changed amount is written and audited**

Click Forward on another Pending row currently at ₱1,000. Change the dropdown to ₱2,000, type
"urgent" in remarks, click Confirm Forward. Check the sheet: `AMOUNT` = 2000, `STATUS` = Processing,
`PROCESSOR_REMARKS` = `"Amount corrected from ₱1000 to ₱2000. urgent"`.

- [ ] **Step 4: Changed amount with no remarks typed**

Repeat Step 3 on a fresh row but leave the remarks textarea blank. Check the sheet:
`PROCESSOR_REMARKS` = `"Amount corrected from ₱X to ₱Y."` with no trailing space or text.

- [ ] **Step 5: Reject ignores the amount dropdown**

Click Reject on a row (the same shared panel opens, showing the amount dropdown). Change the
dropdown to a different value, but only fill in remarks and click Confirm Reject. Check the sheet:
`STATUS` = Rejected, `AMOUNT` is unchanged from before (the dropdown's value was never applied).

- [ ] **Step 6: Batch Forward Selected is unaffected**

Select 2+ Pending rows via their checkboxes, click "Forward Selected" in the bulk toolbar. Confirm
no amount field appears anywhere in the batch flow, and both rows forward with their amounts
unchanged — this path calls `processorReviewBatch`, not `processorReview`, so it was never touched.

---

### Plan self-review notes

- **Spec coverage:** every section of `2026-08-05-processor-amount-edit-design.md` maps to a task —
  "Where it lives" and "Amount input" → Task 2 Steps 1-2; "Audit trail" → Task 1 Step 1; "Scope —
  explicitly out" (reject/batch/approver untouched) → verified in Task 3 Steps 5-6 and by the fact
  no other function is modified anywhere in this plan.
- **Type/signature consistency:** `processorReview`'s new parameter is named `newAmount` in both
  Task 1's server code and Task 2 Step 3's client call — matches the spec's implementation sketch
  exactly, including argument order (`requestId, action, remarks, newAmount, username, password`).
- **No placeholders:** every step has literal before/after code blocks, exact file paths, and exact
  expected command output.
