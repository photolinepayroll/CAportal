# Processor: edit CA amount before forwarding

Date: 2026-08-05

## Problem

The Processor queue in `Admin.html` lets staff Forward or Reject a Pending CA request, but has no
way to correct the CA amount itself. Sometimes the amount an employee selected in the chatbot needs
correcting before it goes to the Approver (e.g. employee picked the wrong tier). Today the only way
to fix this is editing the sheet directly, bypassing the app entirely.

## Goal

Let the Processor correct the CA amount as part of the existing Forward action — no new screen, no
separate action, and without weakening the "CA amount is a fixed enum" rule that's enforced
everywhere else in the system (`CA_AMOUNTS = [500, 1000, 1500, 2000]`, `Code.gs`).

## Design

### Where it lives

The amount control is added to the existing per-row review-inline panel in the Processor queue
(`Admin.html`, `renderProcessorTable`) — the same panel that already contains the remarks textarea
and the Confirm Forward / Confirm Reject / Cancel buttons, opened when the Processor clicks
Forward or Reject on a row. No new button, no separate action.

### Amount input

A `<select id="proc-amount-<requestId>">` dropdown, pre-selected to the request's current amount,
offering the same 4 fixed values Employee.html already presents to employees at request time:
₱500 / ₱1000 / ₱1,500 / ₱2000. This is a closed set, not free text — matches the existing
`CA_AMOUNTS` business rule (`CLAUDE.md`: "CA amount: fixed enum ... No free-text amounts").

The dropdown is present in the shared panel regardless of whether Forward or Reject triggered it
open (consistent with how the remarks textarea already works today — one shared control for both
actions). Its value is only read/applied when the Processor clicks Confirm Forward; it's ignored
on Confirm Reject.

### Audit trail

If the selected amount differs from the request's current amount at the moment Confirm Forward is
clicked, the server auto-prepends a note to `PROCESSOR_REMARKS`:

```
Amount corrected from ₱1000 to ₱2000.
```

...followed by whatever the Processor typed in the remarks textarea, if anything. If the amount
is left unchanged, no note is added and remarks behave exactly as they do today (optional on
forward, required on reject).

### Scope — explicitly out

- **Reject**: unaffected. No amount is written; the dropdown's value is ignored.
- **Batch "Forward Selected"**: unaffected. Batch forwarding stays a single shared remarks box
  applied to N different requests — a single amount value cannot correctly apply across a batch of
  different requests, so amount-editing stays single-row-only.
- **Approver queue**: unaffected. This is Processor-only; `approverReview`/`approverReviewBatch`
  are untouched.

## Implementation sketch

**`Code.gs` — `processorReview`**

Signature gains one parameter, inserted before the credentials:

```js
function processorReview(requestId, action, remarks, newAmount, username, password) {
  requireAccess_(username, password, ROLES.PROCESSOR);
  var req = findRequestByIdOrThrow_(requestId);
  if (req.status !== STATUS.PENDING) throw new Error('Request is not in Pending status.');
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
  return { success: true };
}
```

Server re-validates `newAmount` against `CA_AMOUNTS` itself (defense in depth) rather than
trusting the client's dropdown — same principle already applied to every other field in this
function.

`processorReviewBatch` is untouched — batch forward doesn't take an amount parameter at all.

**`Admin.html` — `renderProcessorTable`**

- Add the amount `<select>` inside the `proc-inline-<requestId>` panel, options built from a
  hardcoded `[500, 1000, 1500, 2000]` list (mirrors Employee.html's existing quick-reply amounts),
  pre-selected to `r.amount`.
- The `[data-confirm]` click handler's `gs('processorReview', ...)` call gains the amount argument,
  read from the new select, inserted in the same position as the new server parameter:
  `gs('processorReview', id, action, remarks, newAmount, session.username, session.password)`.

## Verification

Manual click-through (no automated test runner in this project, per existing convention):

1. Open Processor queue, click Forward on a row currently at ₱1000. Leave the amount dropdown
   untouched, confirm — verify sheet still shows ₱1000 and `PROCESSOR_REMARKS` is unchanged from
   whatever was typed (or blank).
2. Same row (or a new Pending one), click Forward, change the dropdown to ₱2000, type "urgent"
   in remarks, confirm — verify sheet's `AMOUNT` = 2000, `STATUS` = Processing, and
   `PROCESSOR_REMARKS` = "Amount corrected from ₱1000 to ₱2000. urgent".
3. Change the dropdown but leave remarks blank, confirm — verify `PROCESSOR_REMARKS` is just
   "Amount corrected from ₱X to ₱Y." with no trailing text.
4. Click Reject (not Forward) on a row with the amount dropdown visible but untouched — verify
   the amount is never written regardless of the dropdown's value, and reject still requires
   remarks as before.
5. Batch "Forward Selected" on 2+ rows — verify it behaves exactly as before (no amount field
   appears, no amount changes), confirming batch and single-row paths stay independent.
