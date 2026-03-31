const crypto = require("crypto");
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
  validateVideoSlotRequestPayload,
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
const {
  normalizeRole,
  getVideoSlotStatus,
  requestVideoSlot,
  acceptVideoSlotInvite,
  releaseVideoSlot,
  removeUserFromVideoSlotRoom,
  deleteRoomVideoSlots,
} = require("../services/videoSlotService");

const router = express.Router();

const MAX_USERS_PER_ROOM = Number(process.env.MAX_USERS_PER_ROOM || 10);
const MAX_GLOBAL_USERS = Number(process.env.MAX_GLOBAL_USERS || 100);
const RTC_ADMIN_KEY = process.env.RTC_ADMIN_KEY || "";
const PEER_SERVER_KEY = process.env.PEER_SERVER_KEY || "peerjs";
const PEER_SERVER_PATH = normalizePeerServerPath(process.env.PEER_SERVER_PATH || "/peerjs");
const roomPeerIds = new Map();

function sanitizePeerIdPrefix(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "user";
}

function createPeerId(userId) {
  const prefix = sanitizePeerIdPrefix(userId).slice(0, 48);
  const nonce = crypto.randomBytes(6).toString("hex");
  return `${prefix}_${Date.now().toString(36)}_${nonce}`;
}

function getOrCreateRoomPeerMap(roomId) {
  if (!roomPeerIds.has(roomId)) {
    roomPeerIds.set(roomId, new Map());
  }
  return roomPeerIds.get(roomId);
}

function syncRoomPeerMap(roomId) {
  const tracked = roomPeerIds.get(roomId);
  if (!tracked) {
    return;
  }

  const activeUsers = new Set(getRoomUsers(roomId));
  for (const trackedUserId of tracked.keys()) {
    if (!activeUsers.has(trackedUserId)) {
      tracked.delete(trackedUserId);
    }
  }

  if (tracked.size === 0 && activeUsers.size === 0) {
    roomPeerIds.delete(roomId);
  }
}

function setUserPeerId(roomId, userId, peerId) {
  const roomPeerMap = getOrCreateRoomPeerMap(roomId);
  roomPeerMap.set(userId, peerId);
}

function removeUserPeerId(roomId, userId) {
  const roomPeerMap = roomPeerIds.get(roomId);
  if (!roomPeerMap) {
    return;
  }

  roomPeerMap.delete(userId);
  if (roomPeerMap.size === 0) {
    roomPeerIds.delete(roomId);
  }
}

function listRoomParticipants(roomId) {
  syncRoomPeerMap(roomId);
  const roomUsers = getRoomUsers(roomId);
  const roomPeerMap = roomPeerIds.get(roomId);

  return roomUsers.map((participantUserId) => ({
    userId: participantUserId,
    peerId: roomPeerMap?.get(participantUserId) || participantUserId,
  }));
}

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

function assertRoomMemberAccess(roomId, userId, res, options = {}) {
  const touchPresence = options.touchPresence !== false;

  if (!isUserAuthorizedForRoom(roomId, userId)) {
    res.status(403).json({ error: "User is not authorized for this room" });
    return false;
  }

  if (!isUserInRoom(roomId, userId)) {
    res.status(403).json({ error: "User must join room before requesting this resource" });
    return false;
  }

  if (touchPresence) {
    touchUserInRoom(roomId, userId);
  }

  return true;
}

function resolveVideoSlotRole(roomId, userId, rawRole) {
  const policy = getRoomPolicy(roomId);
  if (policy && policy.hostUserId === userId) {
    return "host";
  }

  return normalizeRole(rawRole);
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

  if (!assertRoomMemberAccess(roomId, userId, res, { touchPresence: true })) {
    return;
  }

  const participantEntries = listRoomParticipants(roomId);

  return res.status(200).json({
    roomId,
    participants: participantEntries.map((entry) => entry.userId),
    participantDetails: participantEntries,
  });
});

router.get("/room/:roomId/video-slot/status", (req, res) => {
  const roomId = typeof req.params.roomId === "string" ? req.params.roomId.trim() : "";
  const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";

  const validated = validateJoinLeavePayload({ roomId, userId });
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  if (!assertRoomMemberAccess(roomId, userId, res, { touchPresence: true })) {
    return;
  }

  const snapshot = getVideoSlotStatus({ roomId, userId });
  return res.status(200).json({
    ok: true,
    snapshot,
  });
});

router.post("/room/video-slot/request", (req, res) => {
  const validated = validateVideoSlotRequestPayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, userId, role } = validated.value;
  if (!assertRoomMemberAccess(roomId, userId, res, { touchPresence: true })) {
    return;
  }

  const snapshot = requestVideoSlot({
    roomId,
    userId,
    role: resolveVideoSlotRole(roomId, userId, role),
  });

  return res.status(200).json({
    ok: true,
    snapshot,
  });
});

router.post("/room/video-slot/accept", (req, res) => {
  const validated = validateJoinLeavePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, userId } = validated.value;
  if (!assertRoomMemberAccess(roomId, userId, res, { touchPresence: true })) {
    return;
  }

  const accepted = acceptVideoSlotInvite({ roomId, userId });
  if (!accepted.ok) {
    return res.status(409).json({
      ok: false,
      error: accepted.error,
      snapshot: accepted.snapshot,
    });
  }

  return res.status(200).json({
    ok: true,
    snapshot: accepted.snapshot,
  });
});

router.post("/room/video-slot/release", (req, res) => {
  const validated = validateJoinLeavePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const { roomId, userId } = validated.value;
  if (!assertRoomMemberAccess(roomId, userId, res, { touchPresence: true })) {
    return;
  }

  const released = releaseVideoSlot({ roomId, userId });
  return res.status(200).json({
    ok: true,
    removed: released.removed,
    snapshot: released.snapshot,
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
    const peerId = createPeerId(userId);
    setUserPeerId(roomId, userId, peerId);
    touchUserInRoom(roomId, userId);

    return res.status(200).json({
      ok: true,
      alreadyJoined: true,
      peerId,
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
  const peerId = createPeerId(userId);
  setUserPeerId(roomId, userId, peerId);

  return res.status(200).json({
    ok: true,
    alreadyJoined: false,
    peerId,
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
  removeUserPeerId(roomId, userId);
  removeUserFromVideoSlotRoom(roomId, userId);

  if (result.roomDeleted) {
    roomPeerIds.delete(roomId);
    deleteRoomVideoSlots(roomId);
    deleteRoomPolicy(roomId);
    clearRoomHistory(roomId);
  } else {
    syncRoomPeerMap(roomId);
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
