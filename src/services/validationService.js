function isValidId(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length < 2 || trimmed.length > 128) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

function validateJoinLeavePayload(body) {
  const roomId = body && typeof body.roomId === "string" ? body.roomId.trim() : "";
  const userId = body && typeof body.userId === "string" ? body.userId.trim() : "";

  if (!isValidId(roomId)) {
    return { ok: false, error: "Invalid roomId. Use 2-128 chars: letters, numbers, '_' or '-'." };
  }

  if (!isValidId(userId)) {
    return { ok: false, error: "Invalid userId. Use 2-128 chars: letters, numbers, '_' or '-'." };
  }

  return {
    ok: true,
    value: { roomId, userId },
  };
}

function validateAuthorizeRoomPayload(body) {
  const roomId = body && typeof body.roomId === "string" ? body.roomId.trim() : "";
  const hostUserId = body && typeof body.hostUserId === "string" ? body.hostUserId.trim() : "";
  const rawAllowed = Array.isArray(body?.allowedUserIds) ? body.allowedUserIds : [];
  const allowedUserIds = rawAllowed
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (!isValidId(roomId)) {
    return { ok: false, error: "Invalid roomId. Use 2-128 chars: letters, numbers, '_' or '-'." };
  }

  if (!isValidId(hostUserId)) {
    return { ok: false, error: "Invalid hostUserId." };
  }

  const invalidUser = allowedUserIds.find((userId) => !isValidId(userId));
  if (invalidUser) {
    return { ok: false, error: `Invalid allowed user id: ${invalidUser}` };
  }

  return {
    ok: true,
    value: { roomId, hostUserId, allowedUserIds },
  };
}

function validateChatSendPayload(body) {
  const validatedJoinLeave = validateJoinLeavePayload(body);
  if (!validatedJoinLeave.ok) {
    return validatedJoinLeave;
  }

  const message = body && typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return { ok: false, error: "Message is required" };
  }
  if (message.length > 2000) {
    return { ok: false, error: "Message too long. Max 2000 characters." };
  }

  return {
    ok: true,
    value: {
      ...validatedJoinLeave.value,
      message,
    },
  };
}

function validateChatHistoryQuery(query) {
  const roomId = query && typeof query.roomId === "string" ? query.roomId.trim() : "";
  const userId = query && typeof query.userId === "string" ? query.userId.trim() : "";
  const rawLimit = Number(query?.limit || 60);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 60;

  if (!isValidId(roomId)) {
    return { ok: false, error: "Invalid roomId." };
  }

  if (!isValidId(userId)) {
    return { ok: false, error: "Invalid userId." };
  }

  return {
    ok: true,
    value: { roomId, userId, limit },
  };
}

function validateInvitePayload(body) {
  const roomId = body && typeof body.roomId === "string" ? body.roomId.trim() : "";
  const fromUserId = body && typeof body.fromUserId === "string" ? body.fromUserId.trim() : "";
  const rawUsers = Array.isArray(body?.toUserIds) ? body.toUserIds : [];
  const toUserIds = Array.from(
    new Set(
      rawUsers
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  if (!isValidId(roomId)) {
    return { ok: false, error: "Invalid roomId." };
  }

  if (!isValidId(fromUserId)) {
    return { ok: false, error: "Invalid fromUserId." };
  }

  if (toUserIds.length === 0) {
    return { ok: false, error: "Select at least one user to invite." };
  }

  const invalidUser = toUserIds.find((value) => !isValidId(value));
  if (invalidUser) {
    return { ok: false, error: `Invalid invite target: ${invalidUser}` };
  }

  return {
    ok: true,
    value: { roomId, fromUserId, toUserIds },
  };
}

function validateNotificationQuery(query) {
  const userId = query && typeof query.userId === "string" ? query.userId.trim() : "";
  if (!isValidId(userId)) {
    return { ok: false, error: "Invalid userId." };
  }

  return {
    ok: true,
    value: { userId },
  };
}

function isValidPushEndpoint(value) {
  if (typeof value !== "string") return false;
  const endpoint = value.trim();
  if (!endpoint) return false;
  if (endpoint.length > 2048) return false;
  return endpoint.startsWith("https://");
}

function isValidPushKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (!key) return false;
  if (key.length < 16 || key.length > 512) return false;
  return /^[A-Za-z0-9_-]+$/.test(key);
}

function validatePushSubscribePayload(body) {
  const userId = body && typeof body.userId === "string" ? body.userId.trim() : "";
  const rawSubscription = body && typeof body.subscription === "object" ? body.subscription : null;
  const endpoint = rawSubscription && typeof rawSubscription.endpoint === "string"
    ? rawSubscription.endpoint.trim()
    : "";
  const p256dh = rawSubscription && typeof rawSubscription.keys?.p256dh === "string"
    ? rawSubscription.keys.p256dh.trim()
    : "";
  const auth = rawSubscription && typeof rawSubscription.keys?.auth === "string"
    ? rawSubscription.keys.auth.trim()
    : "";

  if (!isValidId(userId)) {
    return { ok: false, error: "Invalid userId." };
  }

  if (!isValidPushEndpoint(endpoint)) {
    return { ok: false, error: "Invalid push subscription endpoint." };
  }

  if (!isValidPushKey(p256dh) || !isValidPushKey(auth)) {
    return { ok: false, error: "Invalid push subscription keys." };
  }

  return {
    ok: true,
    value: {
      userId,
      subscription: {
        endpoint,
        keys: {
          p256dh,
          auth,
        },
      },
    },
  };
}

function validatePushUnsubscribePayload(body) {
  const userId = body && typeof body.userId === "string" ? body.userId.trim() : "";
  const endpoint = body && typeof body.endpoint === "string" ? body.endpoint.trim() : "";

  if (!isValidId(userId)) {
    return { ok: false, error: "Invalid userId." };
  }

  if (!isValidPushEndpoint(endpoint)) {
    return { ok: false, error: "Invalid push subscription endpoint." };
  }

  return {
    ok: true,
    value: { userId, endpoint },
  };
}

module.exports = {
  validateJoinLeavePayload,
  validateAuthorizeRoomPayload,
  validateChatSendPayload,
  validateChatHistoryQuery,
  validateInvitePayload,
  validateNotificationQuery,
  validatePushSubscribePayload,
  validatePushUnsubscribePayload,
};
