const roomVideoSlots = new Map();

const ROLE_PRIORITY = {
  host: 300,
  speaker: 200,
  participant: 100,
};

const MAX_ACTIVE_VIDEO_SLOTS = parsePositiveInt(process.env.MAX_ACTIVE_VIDEO_SLOTS, 3);
const VIDEO_SLOT_INVITE_TIMEOUT_MS = parsePositiveInt(process.env.VIDEO_SLOT_INVITE_TIMEOUT_MS, 10 * 1000);

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function normalizeRole(role) {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (value === "host" || value === "speaker" || value === "participant") {
    return value;
  }
  if (value === "admin" || value === "owner") {
    return "host";
  }
  if (value === "moderator") {
    return "speaker";
  }
  return "participant";
}

function getRolePriority(role) {
  return ROLE_PRIORITY[normalizeRole(role)] || ROLE_PRIORITY.participant;
}

function getOrCreateRoomState(roomId) {
  if (!roomVideoSlots.has(roomId)) {
    roomVideoSlots.set(roomId, {
      roomId,
      activeUsers: new Set(),
      queue: [],
      invited: null,
      updatedAt: Date.now(),
    });
  }

  return roomVideoSlots.get(roomId);
}

function sortQueue(queue) {
  queue.sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.requestedAt !== right.requestedAt) {
      return left.requestedAt - right.requestedAt;
    }
    return left.userId.localeCompare(right.userId);
  });
}

function findQueueIndex(state, userId) {
  return state.queue.findIndex((entry) => entry.userId === userId);
}

function removeFromQueue(state, userId) {
  const index = findQueueIndex(state, userId);
  if (index === -1) {
    return null;
  }

  const [removed] = state.queue.splice(index, 1);
  return removed || null;
}

function cleanupRoomState(roomId) {
  const state = roomVideoSlots.get(roomId);
  if (!state) {
    return;
  }

  if (state.activeUsers.size > 0 || state.queue.length > 0 || state.invited) {
    return;
  }

  roomVideoSlots.delete(roomId);
}

function enqueueUser(state, userId, role, now, options = {}) {
  const normalizedRole = normalizeRole(role);
  const priority = getRolePriority(normalizedRole);
  const existingIndex = findQueueIndex(state, userId);

  if (existingIndex >= 0) {
    const existing = state.queue[existingIndex];
    state.queue[existingIndex] = {
      ...existing,
      role: normalizedRole,
      priority,
      requestedAt: Number.isFinite(options.requestedAt) ? options.requestedAt : existing.requestedAt,
    };
  } else {
    state.queue.push({
      userId,
      role: normalizedRole,
      priority,
      requestedAt: Number.isFinite(options.requestedAt) ? options.requestedAt : now,
    });
  }

  sortQueue(state.queue);
  state.updatedAt = now;
}

function createInviteFromQueueHead(state, now) {
  if (state.invited || state.activeUsers.size >= MAX_ACTIVE_VIDEO_SLOTS) {
    return;
  }

  const next = state.queue.shift();
  if (!next) {
    return;
  }

  state.invited = {
    userId: next.userId,
    role: next.role,
    priority: next.priority,
    invitedAt: now,
    expiresAt: now + VIDEO_SLOT_INVITE_TIMEOUT_MS,
  };
  state.updatedAt = now;
}

function processInviteTimeout(state, now) {
  if (!state.invited) {
    return;
  }

  if (state.invited.expiresAt > now) {
    return;
  }

  const timedOutInvite = state.invited;
  state.invited = null;

  enqueueUser(state, timedOutInvite.userId, timedOutInvite.role, now, {
    requestedAt: now,
  });
}

function tickRoomState(state, now) {
  processInviteTimeout(state, now);
  createInviteFromQueueHead(state, now);
}

function getUserVideoState(state, userId) {
  if (state.activeUsers.has(userId)) {
    return {
      state: "active",
      position: null,
      role: "participant",
      priority: ROLE_PRIORITY.participant,
      inviteExpiresAt: null,
    };
  }

  if (state.invited && state.invited.userId === userId) {
    return {
      state: "invited",
      position: 0,
      role: state.invited.role,
      priority: state.invited.priority,
      inviteExpiresAt: state.invited.expiresAt,
    };
  }

  const queueIndex = findQueueIndex(state, userId);
  if (queueIndex >= 0) {
    const entry = state.queue[queueIndex];
    return {
      state: "queued",
      position: queueIndex + 1,
      role: entry.role,
      priority: entry.priority,
      inviteExpiresAt: null,
    };
  }

  return {
    state: "off",
    position: null,
    role: "participant",
    priority: ROLE_PRIORITY.participant,
    inviteExpiresAt: null,
  };
}

function toVideoSlotSnapshot(state, userId) {
  const queue = state.queue.map((entry, index) => ({
    userId: entry.userId,
    role: entry.role,
    priority: entry.priority,
    requestedAt: entry.requestedAt,
    position: index + 1,
  }));

  return {
    roomId: state.roomId,
    maxActive: MAX_ACTIVE_VIDEO_SLOTS,
    inviteTimeoutMs: VIDEO_SLOT_INVITE_TIMEOUT_MS,
    activeUserIds: Array.from(state.activeUsers.values()),
    activeCount: state.activeUsers.size,
    invitedUserId: state.invited?.userId || null,
    inviteExpiresAt: state.invited?.expiresAt || null,
    queue,
    queueLength: queue.length,
    you: getUserVideoState(state, userId),
    updatedAt: state.updatedAt,
  };
}

function getVideoSlotStatus({ roomId, userId, now = Date.now() }) {
  const state = getOrCreateRoomState(roomId);
  tickRoomState(state, now);
  const snapshot = toVideoSlotSnapshot(state, userId);
  cleanupRoomState(roomId);
  return snapshot;
}

function requestVideoSlot({ roomId, userId, role, now = Date.now() }) {
  const state = getOrCreateRoomState(roomId);
  tickRoomState(state, now);

  if (state.activeUsers.has(userId)) {
    return toVideoSlotSnapshot(state, userId);
  }

  if (state.invited && state.invited.userId === userId) {
    return toVideoSlotSnapshot(state, userId);
  }

  if (state.activeUsers.size < MAX_ACTIVE_VIDEO_SLOTS && !state.invited && state.queue.length === 0) {
    state.activeUsers.add(userId);
    state.updatedAt = now;
    return toVideoSlotSnapshot(state, userId);
  }

  enqueueUser(state, userId, role, now);
  tickRoomState(state, now);
  return toVideoSlotSnapshot(state, userId);
}

function acceptVideoSlotInvite({ roomId, userId, now = Date.now() }) {
  const state = getOrCreateRoomState(roomId);
  tickRoomState(state, now);

  if (state.activeUsers.has(userId)) {
    return {
      ok: true,
      snapshot: toVideoSlotSnapshot(state, userId),
    };
  }

  if (!state.invited || state.invited.userId !== userId) {
    return {
      ok: false,
      error: "No active invite for this user",
      snapshot: toVideoSlotSnapshot(state, userId),
    };
  }

  if (state.activeUsers.size >= MAX_ACTIVE_VIDEO_SLOTS) {
    const currentInvite = state.invited;
    state.invited = null;
    enqueueUser(state, currentInvite.userId, currentInvite.role, now, { requestedAt: now });
    tickRoomState(state, now);
    return {
      ok: false,
      error: "Video slots are full",
      snapshot: toVideoSlotSnapshot(state, userId),
    };
  }

  state.activeUsers.add(userId);
  state.invited = null;
  state.updatedAt = now;
  tickRoomState(state, now);

  return {
    ok: true,
    snapshot: toVideoSlotSnapshot(state, userId),
  };
}

function releaseVideoSlot({ roomId, userId, now = Date.now() }) {
  const state = getOrCreateRoomState(roomId);
  tickRoomState(state, now);

  const wasActive = state.activeUsers.delete(userId);
  const removedFromQueue = removeFromQueue(state, userId);
  const wasInvited = Boolean(state.invited && state.invited.userId === userId);

  if (wasInvited) {
    state.invited = null;
  }

  if (wasActive || removedFromQueue || wasInvited) {
    state.updatedAt = now;
  }

  if (wasActive || wasInvited) {
    tickRoomState(state, now);
  }

  const snapshot = toVideoSlotSnapshot(state, userId);
  cleanupRoomState(roomId);

  return {
    removed: Boolean(wasActive || removedFromQueue || wasInvited),
    snapshot,
  };
}

function removeUserFromVideoSlotRoom(roomId, userId, now = Date.now()) {
  if (!roomVideoSlots.has(roomId)) {
    return;
  }

  releaseVideoSlot({ roomId, userId, now });
}

function deleteRoomVideoSlots(roomId) {
  roomVideoSlots.delete(roomId);
}

module.exports = {
  MAX_ACTIVE_VIDEO_SLOTS,
  VIDEO_SLOT_INVITE_TIMEOUT_MS,
  normalizeRole,
  getVideoSlotStatus,
  requestVideoSlot,
  acceptVideoSlotInvite,
  releaseVideoSlot,
  removeUserFromVideoSlotRoom,
  deleteRoomVideoSlots,
};
