const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const reason = (value) => String(value || "").normalize("NFKC").trim();

export const receiptCustodyCommandKey = (batchId) => `receipt-custody:${String(batchId || "batch").slice(0, 80)}:${id()}`;
export const receiptConvertCommandKey = (batchId) => `receipt-convert:${String(batchId || "batch").slice(0, 80)}:${id()}`;

/**
 * Reassign custody of already-verified receipts within a batch to partners.
 * Mirrors public.sarraf_assign_receipt_custody(p_batch_id, p_allocations, p_reason, p_command_key).
 */
export async function assignReceiptCustody(client, { batchId, allocations, reason: reasonText, commandKey }) {
  if (!batchId) throw new Error("receipt batch is required");
  if (!Array.isArray(allocations) || !allocations.length) throw new Error("at least one custody allocation is required");
  const why = reason(reasonText);
  if (why.length < 8) throw new Error("an 8-character custody reason is required");
  const key = commandKey || receiptCustodyCommandKey(batchId);
  const { data, error } = await client.rpc("sarraf_assign_receipt_custody", {
    p_batch_id: batchId,
    p_allocations: allocations,
    p_reason: why,
    p_command_key: key,
  });
  if (error) throw error;
  return data;
}

/**
 * Convert accepted receipts in a verified batch into a transaction.
 * Mirrors public.sarraf_convert_receipt_batch_to_transaction(p_batch_id, p_receipt_ids, p_tx, p_reason, p_command_key).
 */
export async function convertReceiptBatchToTransaction(client, {
  batchId, receiptIds, transaction, officeId = null, reason: reasonText, commandKey,
}) {
  if (!batchId) throw new Error("receipt batch is required");
  if (!Array.isArray(receiptIds) || !receiptIds.length) throw new Error("at least one receipt is required");
  if (!transaction || typeof transaction !== "object") throw new Error("transaction payload is required");
  const why = reason(reasonText);
  if (why.length < 8) throw new Error("an 8-character conversion reason is required");
  const key = commandKey || receiptConvertCommandKey(batchId);
  const pendingOfficePurchase = transaction.type === "buy" && transaction.status === "pending";
  if (pendingOfficePurchase && !officeId) throw new Error("office is required for a pending purchase");
  const { data, error } = await client.rpc(
    pendingOfficePurchase
      ? "sarraf_convert_pending_receipt_purchase_with_office"
      : "sarraf_convert_receipt_batch_to_transaction", {
    p_batch_id: batchId,
    p_receipt_ids: receiptIds,
    p_tx: transaction,
    ...(pendingOfficePurchase ? { p_office_id: officeId, p_due_at: null } : {}),
    p_reason: why,
    p_command_key: key,
  });
  if (error) throw error;

  // The conversion creates the transaction; this makes certain the money actually moved. The
  // ledger write is guarded server-side by "only if nothing is there", so whichever path
  // already moved it, it moves exactly once. A failure here must not lose the conversion that
  // has already committed, so it is reported alongside rather than thrown.
  const txId = data?.transactions?.[0]?.id || data?.transaction?.id || data?.tx_id || null;
  if (txId) {
    const settled = await client.rpc("sarraf_convert_receipt_batch_finish", { p_tx_id: txId });
    if (settled.error) {
      console.error("receipt conversion: the ledger movement could not be confirmed", settled.error);
      return { ...data, ledger_confirmed: false, ledger_error: settled.error.message };
    }
    return { ...data, ledger_confirmed: true, ledger_rows: settled.data?.ledger_rows ?? 0 };
  }
  return data;
}

/**
 * Load the customer/partner portal's receipt totals and lifecycle summary.
 * Mirrors public.sarraf_portal_receipt_summary(p_days).
 */
export async function loadPortalReceiptSummary(client, days = 365, subjectId = null) {
  const { data, error } = await client.rpc("sarraf_portal_receipt_summary_v2",
    { p_days: days, p_subject_id: subjectId });
  if (error) throw error;
  return data || { totals: [], batches: [], batch_count: 0, accepted_count: 0, rejected_count: 0 };
}
