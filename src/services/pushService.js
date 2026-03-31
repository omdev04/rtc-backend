const crypto = require("crypto");
let webpush = null;

try {
  // Optional dependency: backend keeps running even if web-push is not installed yet.
  webpush = require("web-push");
} catch {
  console.warn("[push] web-push package is not installed. Push delivery is disabled.");
}

const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
const vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
const vapidSubject = (process.env.VAPID_SUBJECT || "mailto:security@example.com").trim();

const hasVapidConfig = Boolean(vapidPublicKey && vapidPrivateKey && webpush);

if (hasVapidConfig) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else {
  console.warn("[push] VAPID keys missing. Web push notifications are disabled.");
}

// In-memory subscription store scoped to this backend instance.
const userSubscriptions = new Map();

function isConfigured() {
  return Boolean(hasVapidConfig);
}

function getPublicKey() {
  return vapidPublicKey;
}

function getBucket(userId) {
  if (!userSubscriptions.has(userId)) {
    userSubscriptions.set(userId, new Map());
  }
  return userSubscriptions.get(userId);
}

function hashEndpoint(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

function upsertSubscription({ userId, subscription }) {
  if (!isConfigured()) {
    return { ok: false, error: "push-not-configured" };
  }

  const endpointHash = hashEndpoint(subscription.endpoint);
  const bucket = getBucket(userId);

  bucket.set(endpointHash, {
    endpointHash,
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    createdAt: Date.now(),
  });

  return { ok: true, count: bucket.size };
}

function removeSubscription({ userId, endpoint }) {
  const bucket = userSubscriptions.get(userId);
  if (!bucket) {
    return { ok: true, count: 0 };
  }

  const endpointHash = hashEndpoint(endpoint);
  bucket.delete(endpointHash);

  if (bucket.size === 0) {
    userSubscriptions.delete(userId);
  }

  return { ok: true, count: bucket.size };
}

async function sendMeetInvitePush({ toUserId }) {
  if (!isConfigured()) {
    return;
  }

  const bucket = userSubscriptions.get(toUserId);
  if (!bucket || bucket.size === 0) {
    return;
  }

  const payload = JSON.stringify({
    type: "meet_invite",
    title: "Meeting invite",
    body: "A channel meeting has started. Open app to join.",
    url: "/documents",
    tag: "meet-invite",
    createdAt: Date.now(),
  });

  const sends = Array.from(bucket.values()).map(async (subscription) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        payload,
        {
          TTL: 60,
          urgency: "high",
        },
      );
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);

      // Expired or deleted subscription - remove it immediately.
      if (statusCode === 404 || statusCode === 410) {
        bucket.delete(subscription.endpointHash);
      }
    }
  });

  await Promise.allSettled(sends);

  if (bucket.size === 0) {
    userSubscriptions.delete(toUserId);
  }
}

module.exports = {
  isConfigured,
  getPublicKey,
  upsertSubscription,
  removeSubscription,
  sendMeetInvitePush,
};
