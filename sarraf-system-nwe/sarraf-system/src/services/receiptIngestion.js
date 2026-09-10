import { RECEIPT_UPLOAD_LIMIT, validateReceiptUploadCommand } from "./receiptUploadContract.js";

const safeMessage = (stage) => ({
  storage: "وێنەکە هەڵنەگیرا — Image upload failed.",
  finalize: "فیشەکان تۆمار نەکران — Receipt ingestion failed.",
  verify: "دۆخی ناردن نادیارە؛ هەمان ناردن دووبارە بکە — Submission status is unknown; retry safely.",
  cleanup: "پاککردنەوە تەواو نەبوو — Upload cleanup is incomplete.",
}[stage] || "ناردن سەرکەوتوو نەبوو — Submission failed.");

const commandId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const createReceiptIngestionCommand = () => {
  const batchId = commandId();
  return { batchId, idempotencyKey: `receipt-ingest:${batchId}` };
};

export const receiptObjectPath = (batchId, receiptId) => `ingest/${batchId}/${receiptId}.jpg`;

export class ReceiptIngestionError extends Error {
  constructor(stage, cause, outcomeUnknown = false) {
    super(safeMessage(stage));
    this.name = "ReceiptIngestionError";
    this.stage = stage;
    this.outcomeUnknown = outcomeUnknown;
    this.cause = cause;
    this.code = cause?.code || null;
    this.requestId = cause?.requestId || null;
  }
}

export const isMissingReceiptIngestionRpc = (error) => {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  return code === "PGRST202" || /schema cache|could not find the function|sarraf_ingest_receipt_batch/i.test(message);
};

/**
 * The receipt-assurance RPC executes only commands the ingestion service has authorized, and
 * only that service can mint the authorization. A browser calling the RPC directly can never
 * satisfy it, so this is not a failure — it means the command has to be replayed through the
 * server route, which authorizes it and runs the same RPC under the caller's own token.
 */
export const requiresIngestionServiceAuthorization = (error) => {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  return code === "42501" && /not authorized by the ingestion service/i.test(message);
};

async function commitThroughRecoveryApi({ supabase, batch, receipts, commandKey }) {
  const sessionResult = await supabase.auth.getSession();
  const token = sessionResult?.data?.session?.access_token;
  if (!token) {
    const error = new Error("session expired");
    error.code = "session_expired";
    throw error;
  }

  const response = await fetch("/api/receipt-ingestion", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ p_batch: batch, p_receipts: receipts, p_command_key: commandKey }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || "receipt recovery failed");
    error.code = payload?.code || `HTTP_${response.status}`;
    error.requestId = payload?.requestId || null;
    throw error;
  }
  return payload?.data || payload;
}

/**
 * Stage only the command's exact objects, then atomically commit relational rows through the RPC.
 * Storage cannot participate in the SQL transaction; exact-path compensation is used on a known failure.
 */
export async function ingestReceiptBatch({ supabase, command, rows, makeBatch, makeReceipt, onPath, recoveryCommit = commitThroughRecoveryApi }) {
  const paths = [];
  let rpcAttempted = false;
  const cleanup = async () => {
    if (!paths.length) return;
    const { error } = await supabase.storage.from("receipts").remove([...new Set(paths)]);
    if (error) throw new ReceiptIngestionError("cleanup", error, true);
  };

  try {
    const batch = makeBatch();
    // Refuse a malformed group before uploading a single byte. The same contract is checked
    // again by the server route and the database command; this first gate saves bandwidth.
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > RECEIPT_UPLOAD_LIMIT || batch?.id !== command?.batchId) {
      throw new ReceiptIngestionError("finalize", new Error("invalid receipt upload group"));
    }
    const receipts = [];
    for (const row of rows) {
      let path = row.stagedPath || null;
      if (!path && row.blob) {
        path = receiptObjectPath(command.batchId, row.id);
        const { error } = await supabase.storage.from("receipts").upload(path, row.blob, {
          contentType: "image/jpeg", upsert: false,
        });
        if (error && !/already exists|duplicate/i.test(String(error.message || ""))) {
          throw new ReceiptIngestionError("storage", error);
        }
        onPath?.(row.id, path);
      }
      if (!path) throw new ReceiptIngestionError("storage", new Error("missing image"));
      paths.push(path);
      receipts.push(makeReceipt(row, path));
    }

    validateReceiptUploadCommand({ batch, receipts, expectedBatchId: command.batchId });
    rpcAttempted = true;
    const { data: rpcData, error: rpcError } = await supabase.rpc("sarraf_ingest_receipt_batch", {
      p_batch: batch, p_receipts: receipts, p_command_key: command.idempotencyKey,
    });
    let data = rpcData;
    if (rpcError) {
      const serverRoutable = isMissingReceiptIngestionRpc(rpcError) || requiresIngestionServiceAuthorization(rpcError);
      if (!serverRoutable) throw new ReceiptIngestionError("finalize", rpcError);
      data = await recoveryCommit({ supabase, batch, receipts, commandKey: command.idempotencyKey });
    }
    return { committed: true, data, paths };
  } catch (error) {
    const failure = error instanceof ReceiptIngestionError ? error : new ReceiptIngestionError("finalize", error);
    if (rpcAttempted) {
      const probe = await supabase.from("receipt_batches").select("id").eq("id", command.batchId).maybeSingle();
      if (!probe.error && probe.data?.id) return { committed: true, data: probe.data, paths };
      if (probe.error) throw new ReceiptIngestionError("verify", failure, true);
    }
    await cleanup();
    throw failure;
  }
}
