function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function defaultKeyGenerator(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function createRateLimiter(options = {}) {
  const windowMs = toPositiveNumber(options.windowMs, 60 * 1000);
  const maxRequests = toPositiveNumber(options.maxRequests, 60);
  const cleanupIntervalMs = toPositiveNumber(options.cleanupIntervalMs, Math.min(windowMs, 60 * 1000));
  const maxEntries = Math.max(100, Math.floor(toPositiveNumber(options.maxEntries, 5000)));
  const keyGenerator = typeof options.keyGenerator === "function"
    ? options.keyGenerator
    : defaultKeyGenerator;
  const store = new Map();
  let nextCleanupAt = Date.now() + cleanupIntervalMs;

  function clearExpiredBuckets(now) {
    for (const [key, bucket] of store.entries()) {
      if (now > bucket.resetAt) {
        store.delete(key);
      }
    }
  }

  function evictOldestBucket() {
    let oldestKey = null;
    let oldestResetAt = Number.POSITIVE_INFINITY;

    for (const [key, bucket] of store.entries()) {
      if (bucket.resetAt < oldestResetAt) {
        oldestResetAt = bucket.resetAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      store.delete(oldestKey);
    }
  }

  function maybeCleanup(now) {
    if (now < nextCleanupAt) {
      return;
    }

    clearExpiredBuckets(now);
    nextCleanupAt = now + cleanupIntervalMs;
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    maybeCleanup(now);

    const rawKey = keyGenerator(req);
    const normalizedKey = typeof rawKey === "string" ? rawKey.trim() : "";
    const key = normalizedKey || defaultKeyGenerator(req);
    const bucket = store.get(key);

    if (!bucket || now > bucket.resetAt) {
      if (!bucket && store.size >= maxEntries) {
        clearExpiredBuckets(now);

        if (store.size >= maxEntries) {
          evictOldestBucket();
        }
      }

      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= maxRequests) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfterMs: Math.max(0, bucket.resetAt - now),
      });
    }

    bucket.count += 1;
    return next();
  };
}

module.exports = {
  createRateLimiter,
};
