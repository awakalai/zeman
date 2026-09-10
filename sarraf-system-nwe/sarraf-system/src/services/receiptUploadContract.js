export const RECEIPT_UPLOAD_LIMIT = 20;

export const RECEIPT_UPLOAD_PLATFORMS = Object.freeze([
  { value: "alipay", label: "Alipay" },
  { value: "wechat", label: "WeChat" },
]);

const PLATFORM_ALIASES = new Map([
  ["alipay", "alipay"], ["ali pay", "alipay"], ["支付宝", "alipay"],
  ["wechat", "wechat"], ["we chat", "wechat"], ["weixin", "wechat"], ["微信", "wechat"],
]);

export const normalizeReceiptUploadPlatform = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return PLATFORM_ALIASES.get(normalized) || null;
};

export const receiptUploadPlatformLabel = (value) => {
  const normalized = normalizeReceiptUploadPlatform(value);
  return RECEIPT_UPLOAD_PLATFORMS.find((item) => item.value === normalized)?.label || null;
};

export class ReceiptUploadContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReceiptUploadContractError";
    this.code = code;
  }
}

export function validateReceiptUploadSelection({ files, platform, hasActiveGroup = false }) {
  const images = Array.from(files || []).filter((file) => String(file?.type || "").startsWith("image/"));
  const declaredPlatform = normalizeReceiptUploadPlatform(platform);
  if (!declaredPlatform) {
    throw new ReceiptUploadContractError("platform_required");
  }
  if (hasActiveGroup) {
    throw new ReceiptUploadContractError("upload_group_locked");
  }
  if (!images.length) {
    throw new ReceiptUploadContractError("images_required");
  }
  if (images.length > RECEIPT_UPLOAD_LIMIT) {
    throw new ReceiptUploadContractError("receipt_limit");
  }
  return { files: images, platform: declaredPlatform };
}

export function validateReceiptUploadCommand({ batch, receipts, expectedBatchId = null }) {
  const declaredPlatform = normalizeReceiptUploadPlatform(batch?.platform);
  if (!declaredPlatform) {
    throw new ReceiptUploadContractError("platform_required");
  }
  if (!Array.isArray(receipts) || receipts.length < 1 || receipts.length > RECEIPT_UPLOAD_LIMIT) {
    throw new ReceiptUploadContractError("invalid_count");
  }
  if (expectedBatchId && batch?.id !== expectedBatchId) {
    throw new ReceiptUploadContractError("batch_conflict");
  }
  for (const receipt of receipts) {
    if (receipt?.batch_id !== batch?.id) {
      throw new ReceiptUploadContractError("batch_conflict");
    }
    if (normalizeReceiptUploadPlatform(receipt?.platform) !== declaredPlatform) {
      throw new ReceiptUploadContractError("mixed_platform");
    }
  }
  return { platform: declaredPlatform, count: receipts.length };
}
