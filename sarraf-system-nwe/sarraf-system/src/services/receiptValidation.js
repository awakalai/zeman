const cleanIdentifier = (value) => String(value ?? "").normalize("NFKC").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

const moneyUnits = (value, decimals = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(Math.abs(number) * (10 ** decimals));
};

export function receiptIdentity(receipt) {
  const orderNo = cleanIdentifier(receipt?.orderNo ?? receipt?.refNo ?? receipt?.ref_no);
  const merchantOrderNo = cleanIdentifier(receipt?.merchantOrderNo ?? receipt?.merchant_order_no);
  const imageHash = cleanIdentifier(receipt?.imageHash ?? receipt?.hash ?? receipt?.image_hash);
  if (orderNo) return `order:${orderNo}`;
  if (merchantOrderNo) return `merchant:${merchantOrderNo}`;
  if (imageHash) return `image:${imageHash}`;
  return null;
}

export function validateReceiptArithmetic(receipt, decimals = 2) {
  const gross = moneyUnits(receipt?.amount ?? receipt?.grossAmount, decimals);
  const fee = moneyUnits(receipt?.fee ?? 0, decimals);
  // An order amount of zero is the reader saying the receipt states none — a payment of nothing
  // is not a payment. Kept as a real order it made `expectedNet = order ?? (gross - fee)` return
  // 0, because ?? only falls through on null, and every honest receipt was accused on screen of
  // "1,246.30 − 36.30 = 0.00، بەڵام 1,210.00 نووسراوە". receiptNetFrom below already guards this
  // with `order > 0`; this line did not.
  const order = moneyUnits(receipt?.orderAmount, decimals) || null;
  const net = moneyUnits(receipt?.netAmount ?? receipt?.net, decimals);
  const tolerance = 1;
  const issues = [];

  if (gross == null || gross <= 0) issues.push("invalid_gross_amount");
  if (fee == null) issues.push("invalid_fee");
  if (order != null && gross != null && fee != null && Math.abs(gross - (order + fee)) > tolerance) {
    issues.push("gross_order_fee_mismatch");
  }
  const expectedNet = order ?? (gross != null && fee != null ? gross - fee : null);
  if (net != null && expectedNet != null && Math.abs(net - expectedNet) > tolerance) issues.push("net_amount_mismatch");
  if (gross != null && fee != null && fee > gross) issues.push("fee_exceeds_gross");

  return {
    valid: issues.length === 0,
    issues,
    gross: gross == null ? null : gross / (10 ** decimals),
    fee: fee == null ? null : fee / (10 ** decimals),
    orderAmount: order == null ? null : order / (10 ** decimals),
    netAmount: expectedNet == null ? null : expectedNet / (10 ** decimals),
  };
}

const numberOrNull = (value) => {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Net amount a receipt contributes to the accounting set.
 *
 * An explicit order amount wins only when it is a real positive number. Guarding on
 * Number.isFinite(Number(orderAmount)) alone is not enough: Number(null) is 0, which is
 * finite, so a missing order amount — the common case — would resolve the net to 0 and
 * silently drop the receipt's value.
 */
export function receiptNetFrom({ amount, fee, orderAmount } = {}) {
  const order = numberOrNull(orderAmount);
  if (order != null && order > 0) return Math.abs(order);
  const gross = numberOrNull(amount);
  if (gross == null) return null;
  const feeValue = numberOrNull(fee);
  return Math.max(0, Math.abs(gross) - (feeValue == null ? 0 : Math.abs(feeValue)));
}

/**
 * Why this receipt's figures do not reconcile — in words, naming the numbers.
 *
 * The owner sent eleven receipts. Three were refused and there was, in their words, "no way
 * whatsoever" to review them: the rule that decided a row looked fine and the rule that decided
 * a row could be sent were different rules. A receipt with no order amount was never
 * arithmetic-checked when its status was set, so it showed green with no mark and no control —
 * and was then refused by the send gate, which checks every row. The screen said three receipts
 * were wrong and marked none of them, so there was nothing to click. They deleted the three.
 *
 * There is now one rule, and it says which numbers disagree, because "3 receipts do not add up"
 * is not something a person can act on.
 */
export function arithmeticObjection(receipt, decimals = 2) {
  const result = validateReceiptArithmetic({
    amount: receipt?.amount ?? receipt?.grossAmount,
    fee: receipt?.fee,
    orderAmount: receipt?.orderAmount ?? receipt?.order_amount,
    netAmount: receipt?.netAmount ?? receipt?.net ?? receipt?.net_amount,
  }, decimals);
  if (result.valid) return null;

  const money = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: decimals }));
  const stated = receipt?.netAmount ?? receipt?.net ?? receipt?.net_amount;

  // A receipt the reader could not put a number on is evidence, not a sum that fails to add up.
  // Saying "the figures do not agree" about a receipt with no figures explains nothing.
  const reason = result.issues.includes("invalid_gross_amount")
    ? "بڕەکە نەخوێندراوەتەوە"
    : result.issues.includes("fee_exceeds_gross")
      ? `فی (${money(result.fee)}) لە بڕەکە (${money(result.gross)}) زیاترە`
      : `ژمارەکان یەک ناگرنەوە: ${money(result.gross)} − ${money(result.fee)} = ${money(result.netAmount)}، بەڵام ${money(stated)} نووسراوە`;

  return { id: receipt?.id ?? null, issues: result.issues, reason, ...result };
}

/** Receipts whose arithmetic does not reconcile must never reach the ingestion command. */
export function unsendableReceipts(receipts, decimals = 2) {
  return (receipts || []).reduce((out, receipt) => {
    const result = validateReceiptArithmetic({
      amount: receipt?.amount,
      fee: receipt?.fee,
      orderAmount: receipt?.orderAmount,
      netAmount: receipt?.net ?? receipt?.netAmount,
    }, decimals);
    if (!result.valid) out.push({ id: receipt?.id ?? null, issues: result.issues });
    return out;
  }, []);
}

export function classifyReceiptSet(receipts) {
  const seen = new Map();
  return (receipts || []).map((receipt) => {
    const identity = receiptIdentity(receipt);
    const duplicateOf = identity && seen.get(identity);
    if (identity && !duplicateOf) seen.set(identity, receipt.id ?? receipt.source ?? identity);
    return {
      ...receipt,
      identity,
      duplicate: Boolean(duplicateOf),
      duplicateOf: duplicateOf || null,
      validation: validateReceiptArithmetic(receipt),
    };
  });
}


/**
 * Splitting a batch into what counts and what merely travels with it.
 *
 * The uploader supplies evidence; the operator reviews it. A receipt the uploader is not
 * allowed to correct must therefore never hold their whole batch — it goes along, marked, and
 * counts towards nothing, exactly as a receipt rejected for being a duplicate already does.
 * Holding the batch is how eleven receipts became eight receipts and three deletions, and
 * deleting evidence is the one outcome the system exists to prevent.
 *
 * Staff are stopped instead of carried, because staff *can* put it right: for them the refusal
 * is a useful one, pointing at figures they have the reviewed correction path to fix.
 */
export function sendableSet(rows, { mayResolve = false } = {}) {
  const counted = [];
  const evidence = [];
  const objections = [];

  for (const row of rows || []) {
    // Already rejected: it travels as it is, with the reason it was given.
    if (row?.counted === false || row?.status === "dup" || row?.status === "error") {
      evidence.push(row);
      continue;
    }
    const objection = arithmeticObjection(row);
    if (!objection) { counted.push(row); continue; }

    objections.push(objection);
    if (mayResolve) continue;
    evidence.push({
      ...row,
      status: "error",
      counted: false,
      reject_code: row?.reject_code || "amount_validation",
      rejectCode: row?.rejectCode || "amount_validation",
      reject_reason: objection.reason,
      rejectReason: objection.reason,
    });
  }

  return { counted, evidence, objections, blocked: mayResolve && objections.length > 0 };
}
