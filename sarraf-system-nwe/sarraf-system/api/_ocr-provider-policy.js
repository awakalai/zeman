const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const CONFIGURATION_PATTERN = /api[ _-]?key|billing|permission denied|forbidden|unauthori[sz]ed|credential|model.*not found|not configured/i;
const TRANSIENT_PATTERN = /rate limit|quota|timed? out|timeout|temporar|service unavailable|overloaded|try again/i;

export function classifyOcrProviderError(error) {
  const status = Number(error?.status) || null;
  const message = String(error?.message || error || "");
  if (status === 400 || status === 413 || status === 415) {
    return { fallback: false, retrySameProvider: false, retryable: false, category: "invalid_input" };
  }
  if ([401, 403, 404, 422].includes(status) || CONFIGURATION_PATTERN.test(message)) {
    return { fallback: true, retrySameProvider: false, retryable: false, category: "provider_configuration" };
  }
  if (TRANSIENT_STATUSES.has(status) || TRANSIENT_PATTERN.test(message)) {
    return { fallback: true, retrySameProvider: true, retryable: true, category: "provider_temporary" };
  }
  return { fallback: false, retrySameProvider: false, retryable: false, category: "provider_terminal" };
}

const boundedDelay = (error) => {
  const requested = Number(error?.retryAfterSeconds);
  if (Number.isFinite(requested) && requested > 0) return Math.min(1500, Math.ceil(requested * 1000));
  return 500;
};

/** Run the configured readers in order, with one bounded final-provider retry. */
export async function runOcrProviders(providers, args, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const attempts = [];
  let lastError = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      const result = await provider.fn(provider.key, ...args);
      result.meta = {
        ...(result.meta || {}),
        fallbackFrom: attempts.map((attempt) => attempt.provider),
        attempts,
      };
      return result;
    } catch (error) {
      lastError = error;
      const policy = classifyOcrProviderError(error);
      attempts.push({
        provider: provider.name,
        status: Number(error?.status) || null,
        category: policy.category,
        retryable: policy.retryable,
        message: String(error?.message || error).slice(0, 220),
      });
      if (!policy.fallback) {
        error.attempts = attempts;
        error.retryable = policy.retryable;
        throw error;
      }

      // Prefer another configured reader immediately. Only the last reader is retried, once,
      // and the wait is capped so a provider's long Retry-After cannot hold a serverless request.
      if (index === providers.length - 1 && policy.retrySameProvider) {
        await sleep(boundedDelay(error));
        try {
          const result = await provider.fn(provider.key, ...args);
          result.meta = {
            ...(result.meta || {}),
            fallbackFrom: attempts.map((attempt) => attempt.provider),
            attempts,
          };
          return result;
        } catch (retryError) {
          lastError = retryError;
          const retryPolicy = classifyOcrProviderError(retryError);
          attempts.push({
            provider: provider.name,
            status: Number(retryError?.status) || null,
            category: retryPolicy.category,
            retryable: retryPolicy.retryable,
            message: String(retryError?.message || retryError).slice(0, 220),
          });
        }
      }
    }
  }

  const error = lastError || new Error("OCR providers failed");
  error.attempts = attempts;
  error.retryable = attempts.some((attempt) => attempt.retryable);
  throw error;
}
