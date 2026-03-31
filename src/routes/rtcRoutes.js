const express = require("express");

const {
  rooms,
  globalUsers,
  addUserToRoom,
  getRoomUsers,
  getHealthSnapshot,
  isUserInRoom,
  removeUserFromRoom,
  touchUserInRoom,
} = require("../services/stateService");
const {
  validateAuthorizeRoomPayload,
  validateChatHistoryQuery,
  validateInvitePayload,
  validateNotificationQuery,
  validatePushSubscribePayload,
  validatePushUnsubscribePayload,
  validateChatSendPayload,
  validateJoinLeavePayload,
} = require("../services/validationService");
const {
  addAllowedUsersToRoomPolicy,
  deleteRoomPolicy,
  getRoomPolicy,
  isUserAuthorizedForRoom,
  serializeRoomPolicy,
  upsertRoomPolicy,
} = require("../services/roomPolicyService");
const {
  addRoomMessage,
  clearRoomHistory,
  getRoomHistory,
} = require("../services/chatService");
const {
  enqueueMeetInvite,
  pullUserNotifications,
} = require("../services/meetInviteService");
const {
  getPublicKey,
  isConfigured,
  removeSubscription,
  upsertSubscription,
} = require("../services/pushService");

const router = express.Router();

const MAX_USERS_PER_ROOM = Number(process.env.MAX_USERS_PER_ROOM || 10);
const MAX_GLOBAL_USERS = Number(process.env.MAX_GLOBAL_USERS || 100);
const RTC_ADMIN_KEY = process.env.RTC_ADMIN_KEY || "";
const PEER_SERVER_KEY = process.env.PEER_SERVER_KEY || "peerjs";
const PEER_SERVER_PATH = normalizePeerServerPath(process.env.PEER_SERVER_PATH || "/peerjs");

function normalizePeerServerPath(path) {
  const normalized = typeof path === "string" ? path.trim() : "";
  if (!normalized) {
    return "/peerjs";
  }

  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withLeadingSlash.endsWith("/") && withLeadingSlash.length > 1
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function getPeerConnectionConfig() {
  return {
    key: PEER_SERVER_KEY,
    path: PEER_SERVER_PATH,
  };
}

function assertAdminKey(req, res) {
  if (!RTC_ADMIN_KEY) {
    return true;
  }

  const provided = req.headers["x-rtc-admin-key"];
  if (typeof provided !== "string" || provided !== RTC_ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized admin request" });
    return false;
  }

  return true;
}

router.post("/room/authorize", (req, res) => {
  if (!assertAdminKey(req, res)) {
    return;
  }

  const validated = validateAuthorizeRoomPayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const policy = upsertRoomPolicy(validated.value);

  return res.status(200).json({
    ok: true,
    policy: serializeRoomPolicy(policy),
  });
});

router.get("/room/:roomId", (req, res) => {
  if (!assertAdminKey(req, res)) {
    return;
  }

  const roomId = typeof req.params.roomId === "string" ? req.params.roomId.trim() : "";
  const policy = getRoomPolicy(roomId);

  if (!policy) {
    return res.status(404).json({ error: "Room policy not found" });
  }

  return res.status(200).json({ policy: serializeRoomPolicy(policy) });
});

router.post("/room/invite", (req, res) => {
  if (!assertAdminKey(req, res)) {
    return;
  }

  const validated = validateInvitePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, fromUserId, toUserIds } = validated.value;
  let policy = getRoomPolicy(roomId);

  if (!policy) {
    policy = upsertRoomPolicy({
      roomId,
      hostUserId: fromUserId,
      allowedUserIds: toUserIds,
    });
  } else {
    policy = addAllowedUsersToRoomPolicy(roomId, [fromUserId, ...toUserIds]);
  }

  const invited = [];
  for (const userId of toUserIds) {
    if (userId === fromUserId) {
      continue;
    }
    const notification = enqueueMeetInvite({
      roomId,
      fromUserId,
      toUserId: userId,
    });
    invited.push(notification);
  }

  return res.status(200).json({
    ok: true,
    invited,
    policy: serializeRoomPolicy(policy),
  });
});

router.get("/notifications", (req, res) => {
  const validated = validateNotificationQuery(req.query);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { userId } = validated.value;
  return res.status(200).json({
    ok: true,
    notifications: pullUserNotifications(userId),
  });
});

router.get("/push/public-key", (_req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: "Push service is not configured" });
  }

  return res.status(200).json({
    ok: true,
    publicKey: getPublicKey(),
  });
});

router.post("/push/subscribe", (req, res) => {
  const validated = validatePushSubscribePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  if (!isConfigured()) {
    return res.status(503).json({ error: "Push service is not configured" });
  }

  const result = upsertSubscription(validated.value);
  if (!result.ok) {
    return res.status(503).json({ error: "Push service unavailable" });
  }

  return res.status(200).json({
    ok: true,
    subscriptions: result.count,
  });
});

router.post("/push/unsubscribe", (req, res) => {
  const validated = validatePushUnsubscribePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const result = removeSubscription(validated.value);
  return res.status(200).json({
    ok: true,
    subscriptions: result.count,
  });
});

router.get("/room/:roomId/participants", (req, res) => {
  const roomId = typeof req.params.roomId === "string" ? req.params.roomId.trim() : "";
  const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";

  const validated = validateJoinLeavePayload({ roomId, userId });
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  if (!isUserAuthorizedForRoom(roomId, userId)) {
    return res.status(403).json({ error: "User is not authorized for this room" });
  }

  if (!isUserInRoom(roomId, userId)) {
    return res.status(403).json({ error: "User must join room before requesting participants" });
  }

  touchUserInRoom(roomId, userId);

  return res.status(200).json({
    roomId,
    participants: getRoomUsers(roomId),
  });
});

router.post("/join", (req, res) => {
  const validated = validateJoinLeavePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, userId } = validated.value;

  const roomPolicy = getRoomPolicy(roomId);
  if (!roomPolicy) {
    return res.status(403).json({
      error: "Room is not authorized. Ask admin/host to authorize this room first.",
    });
  }

  if (!isUserAuthorizedForRoom(roomId, userId)) {
    return res.status(403).json({
      error: "User is not authorized for this room",
    });
  }

  if (isUserInRoom(roomId, userId)) {
    touchUserInRoom(roomId, userId);

    return res.status(200).json({
      ok: true,
      alreadyJoined: true,
      peerId: userId,
      peerConfig: getPeerConnectionConfig(),
    });
  }

  const room = rooms.get(roomId);
  const roomSize = room ? room.size : 0;
  if (roomSize >= MAX_USERS_PER_ROOM) {
    return res.status(403).json({
      error: "Room user limit exceeded",
      limit: MAX_USERS_PER_ROOM,
    });
  }

  const isGlobalNewUser = !globalUsers.has(userId);
  if (isGlobalNewUser && globalUsers.size >= MAX_GLOBAL_USERS) {
    return res.status(403).json({
      error: "Global user limit exceeded",
      limit: MAX_GLOBAL_USERS,
    });
  }

  addUserToRoom(roomId, userId);

  return res.status(200).json({
    ok: true,
    alreadyJoined: false,
    peerId: userId,
    peerConfig: getPeerConnectionConfig(),
  });
});

router.post("/leave", (req, res) => {
  const validated = validateJoinLeavePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, userId } = validated.value;
  const result = removeUserFromRoom(roomId, userId);

  if (result.roomDeleted) {
    deleteRoomPolicy(roomId);
    clearRoomHistory(roomId);
  }

  return res.status(200).json({
    ok: true,
    removedFromRoom: result.removedFromRoom,
    roomDeleted: result.roomDeleted,
  });
});

router.post("/chat/send", (req, res) => {
  const validated = validateChatSendPayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, userId, message } = validated.value;

  if (!isUserAuthorizedForRoom(roomId, userId) || !isUserInRoom(roomId, userId)) {
    return res.status(403).json({ error: "User cannot send chat in this room" });
  }

  touchUserInRoom(roomId, userId);

  const payload = addRoomMessage({ roomId, userId, message });
  return res.status(200).json({ ok: true, message: payload });
});

router.get("/chat/history", (req, res) => {
  const validated = validateChatHistoryQuery(req.query);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, userId, limit } = validated.value;
  if (!isUserAuthorizedForRoom(roomId, userId)) {
    return res.status(403).json({ error: "User is not authorized for this room" });
  }

  if (isUserInRoom(roomId, userId)) {
    touchUserInRoom(roomId, userId);
  }

  return res.status(200).json({
    roomId,
    messages: getRoomHistory(roomId, limit),
  });
});

router.get("/health", (_req, res) => {
  return res.status(200).json(getHealthSnapshot());
});

module.exports = router;
