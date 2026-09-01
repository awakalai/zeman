# Owner Acceptance Accounting Matrix

Required by §1 before any financial command changes. Nothing in the settlement, commission or
office rounds may be implemented until the scenario it belongs to is filled in here and the owner
has accepted it.

**Status of this document: DRAFT — awaiting owner acceptance.** Rows marked ❓ are the ones I must
not guess at. They are questions for the owner, not gaps to fill in with something plausible.

## The accounts that already exist

Taken from `public.chart_of_accounts`, not invented. §2 forbids creating duplicate financial
concepts under new names, so every scenario below maps onto these.

| Code | Name | Use |
|---|---|---|
| `acc-1000` | قاسەی سەرەکی — Main safe | Money physically held by the owner |
| `acc-1100` | پارەی لای هاوبەشان — Partner-held funds | Money physically held by a partner |
| `acc-1200` | قەرزاری کڕیاران — Customer receivable | A customer owes the business |
| `acc-1300` | قەرزاری نووسینگە — Office receivable | An office owes the business / holds its money |
| `acc-1400` | مەخزەنی دراو — Currency inventory | FX inventory at weighted-average cost |
| `acc-2000` | قاسەی کڕیاران — Customer funds held | Customer money the business is holding |
| `acc-2100` | قەرزی ZEMAN بۆ هاوبەشان — Partner payable | The business owes a partner |
| `acc-2200` | قەرزی ZEMAN بۆ نووسینگە — Office payable | The business owes an office |
| `acc-2300` | قەرزی ZEMAN بۆ کڕیاران — Customer payable | The business owes a customer |
| `acc-4000` | قازانجی ئاڵوگۆڕ — Exchange spread income | FX spread only |
| `acc-4100` | داهاتی فی — Fee income | Service fee income |
| `acc-4900` / `acc-5900` | FX revaluation gain / loss | Revaluation only |

**A finding that shapes everything below.** The double-entry journal already knows about offices
and partners — `acc-1100`, `acc-1300`, `acc-2200` all exist. The operational `public.ledger`,
which is what the cashbox screen is computed from, does not: its columns are
`owner, investor_id, cur_id, amount, partner_id, tx_id, …` with **no office and no location**.
So the two layers disagree about whether "where is this money" is a question the system can
answer. That disagreement is the negative-CNY defect (§8) and the office defect (§5.2, §6.1)
in one.

## What the negative CNY cashbox actually is

Established by reading the code, not inferred:

```
atMe[c] = phys[c] − Σ partner[c]                                    src/App.jsx
phys    = sum(amount) from ledger group by cur_id                   read model
partner = sum(amount) from ledger where partner_id is not null      read model
```

The owner cashbox is therefore **the sum of every ledger row that names no partner** — a residual,
not an account. Nothing constrains a residual to stay positive, and no office term appears at all.
`sarraf_explain_balance` and `sarraf_balance_first_negative` (migration `202609010009`) now show
every movement and name the first one that crossed zero, so the live figure can be explained
before anything is changed.

---

## Scenario A — FIB service commission (§3.3, §15.A)

| Field | Value |
|---|---|
| Transaction type | Service / Commission — **not** an FX purchase or sale |
| Initiating role | Admin or owner |
| Counterparty | The customer receiving the service |
| Principal amount and currency | IQD 1,000,000 |
| Settlement amount and currency | IQD 1,000,000 principal + IQD 3,000 commission |
| Source account | FIB bank account |
| Destination account | `acc-1000` Main safe |
| Physical holder afterwards | Owner |
| Responsible for collecting | Owner |
| Customer payable / receivable | None on the principal. Commission: `acc-1200` if deferred |
| Office balance | Not involved |
| Owner cashbox effect | **+IQD 1,000,000**, and +IQD 3,000 only if collected now |
| CNY inventory effect | **None** |
| Commission effect | **+IQD 3,000 to `acc-4100`** |
| Journal effect | Dr `acc-1000` 1,000,000 / Cr FIB 1,000,000; then Dr `acc-1000` (or `acc-1200`) 3,000 / Cr `acc-4100` 3,000 |
| Settlement action | Collected now, or Commission Receivable until settled |
| Final expected balances | FIB −1,000,000; safe +1,000,000 (+3,000 if collected); `acc-4100` +3,000 |
| Partial settlement | Commission may be partly collected; remainder stays receivable |
| Reversal | Existing reversal model — never a delete or an edit |

**Must be true and is testable:** WAC, FX spread and purchase/sale profit are all untouched, and
the IQD 1,000,000 and the IQD 3,000 are never added together into one figure (§3.3).

❓ **For the owner:** is the FIB account already represented in `chart_of_accounts`, or does a bank
account need adding? It is not in the list above, and I will not invent one.

---

## Scenario B — Direct CNY purchase, owner pays (§4, §15.B)

| Field | Value |
|---|---|
| Transaction type | FX purchase — existing validated purchase/inventory logic, unchanged |
| Counterparty | The seller |
| Principal | CNY bought, at the agreed rate |
| Physical holder of the CNY | Owner |
| Responsible for paying | **Owner** (explicit at creation) |
| Customer payable | `acc-2300` — the business owes the seller until paid |
| Owner cashbox effect | Decreases **only when a payment is recorded**, never at creation |
| CNY inventory | Increases through the existing purchase command |
| Journal at creation | Dr `acc-1400` inventory / Cr `acc-2300` customer payable |
| Journal at payment | Dr `acc-2300` / Cr `acc-1000` |
| Partial settlement | Payable reduces by the amount paid; remainder stays |
| Final | Seller balance reaches zero only when the authoritative remaining amount is zero |
| Reversal | Audited reversal of the settlement event |

---

## Scenario C — Direct CNY purchase, office pays (§6.1, §15.C)

| Field | Value |
|---|---|
| Responsible for paying | **Office X** (explicit at creation, not editable after settlement begins) |
| Customer-facing statement | «پارەکەت لای نووسینگەی X ــە / نووسینگەی X پێت دەدات» |
| Owner as direct debtor | **No** — the owner must not appear as the customer's debtor |
| Owner → Office transfer | Dr `acc-1300` office receivable / Cr `acc-1000`. **This is not a payment to the customer.** |
| Office pays the customer | Dr `acc-2300` customer payable / Cr `acc-1300` office-held funds |
| Owner cashbox at that moment | Unchanged — the money left when it went to the office |
| Final | Customer obligation zero; office balance reduced by what it paid out |

❓ **For the owner:** when Office X pays a customer **out of money it collected from other
customers** rather than out of a transfer from the owner, which account funds it? This changes
whether `acc-1300` can go negative, and I will not decide it.

---

## Scenario D — Direct CNY sale, owner collects (§5.1, §15.D)

| Field | Value |
|---|---|
| Transaction type | FX sale — existing validated sale/inventory logic, unchanged |
| Buyer receivable | `acc-1200` at creation |
| Owner cashbox | Increases **only when a receipt is recorded** |
| CNY inventory | Decreases through the existing sale command only |
| Journal at creation | Dr `acc-1200` / Cr `acc-1400` inventory + `acc-4000` spread |
| Journal at receipt | Dr `acc-1000` / Cr `acc-1200` |
| States | Unsettled → Partially received → Received → Reversed |
| Partial settlement | Receivable reduces; remainder stays |

---

## Scenario E — Direct CNY sale, office collects (§5.2, §15.E)

Two events that must never be collapsed into one:

| Event | Journal | Owner cashbox |
|---|---|---|
| Office X collects from the buyer | Dr `acc-1300` office receivable / Cr `acc-1200` customer receivable | **Unchanged** |
| Office X later remits to the owner | Dr `acc-1000` / Cr `acc-1300` | **Increases** |

The buyer's receivable reaches zero at the first event. The owner's cashbox rises only at the
second. Partial remittance leaves the correct remaining office balance. The owner's screen must
say that Office X collected and currently holds the money.

---

## Scenario F — Missing Order No. (§10, §15.F)

Not an accounting scenario: the required outcome is that **no journal entry and no transaction
exist at all**. The image and metadata are preserved; the receipt is marked rejected or
needs-review with the exact reason `Order No. is required.` Enforced server-side.

## Scenario G — OCR missed a visible Order No. (§10.1, §15.G)

Raw OCR value immutable and preserved. An authorized administrator enters a versioned correction
with a reason; before and after are both kept; duplicate and validation checks re-run afterwards.
The original uploader may never rewrite an immutable OCR field.

## Scenario H — Receipt privacy (§9, §15.H)

Delivered ahead of this matrix, because it is a privacy defect rather than an accounting change.
Migration `202609010008`: the three portal loaders take a subject and `sarraf_portal_subject()`
decides who may name one. Proven by 9 checks in `verify:isolation` and 6 unit tests.

## Scenario I — 100-receipt export (§11, §15.I)

No accounting effect. Authorization re-checked server-side per receipt; manifest carries Order No.;
expiring signed access only; audit event records actor, tenant, count, batch reference, time and
method. A failed export must not change any receipt's status.

## Scenario J — Negative CNY regression (§8, §15.J)

Root cause established above. `sarraf_explain_balance` makes the current figure explainable.
**The repair itself is blocked on this matrix**, because it requires deciding whether the ledger
gains a location dimension — which changes what a financial write means.

❓ **For the owner, and this is the important one:** should `public.ledger` gain an explicit holder
(owner / office / partner) so that "where is this money" has one answer, with the cashbox becoming
a real balance instead of a residual? That is the fix that makes a negative impossible rather than
merely visible. It is a schema change to the financial core, so it needs your acceptance first.

---

## OWNER-DISCOVERY-001 — Complex transaction workflow pending verbal clarification

**Status: PENDING — to be explained by phone. Nothing has been assumed, built, posted or stubbed.**

Per §16: no assumed journal behaviour, no placeholder financial posting, no fake UI action.

### Questions required for the phone discussion

1. What triggers this transaction, and who initiates it?
2. Who are the parties, and is any of them an office or a partner rather than a customer?
3. What moves — currency, principal, a fee, or a claim?
4. Which currency is the principal in, and which is settlement in?
5. Who physically holds the money at each step?
6. Who is legally or operationally responsible for paying or collecting?
7. Is it settled immediately, in stages, or on a later date?
8. Can it be partially settled? What is the remaining balance called?
9. Does it touch CNY inventory, or is it a service like Scenario A?
10. Is a commission earned, and if so who pays it and into which account?
11. How is it reversed when it is wrong?
12. What does the customer see, and what should the statement say?

### Accounting matrix fields that must be completed afterwards

Every field in the header list of this document: transaction type, initiating role, counterparty,
principal amount and currency, settlement amount and currency, source account, destination
account, physical holder, responsible party, customer payable/receivable, office
payable/receivable/custody, owner cashbox effect, CNY inventory effect, commission effect, journal
effect, settlement action, final expected balances, partial-settlement behaviour, reversal
behaviour.

### Tests that will be required afterwards

A database contract test for the journal effect; a business-flow scenario end to end; partial
settlement; retry/idempotency under a repeated command key; wrong tenant; suspended tenant;
unauthorized role; and a reversal that restores the prior balances exactly.

### Effect on readiness

This item does not block the confirmed requirements. It **does** block any claim that the system
as a whole is ready for real money, and it stays in the readiness report until the call happens.
