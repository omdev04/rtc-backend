const { buildValkeyKey, runValkeyCommand } = require("./valkeyService");

const roomVideoSlots = new Map();
const VIDEO_SLOT_SNAPSHOT_KEY = buildValkeyKey("video-slot:snapshot:v1");

let initialized = false;
let initializingPromise = null;
let persistScheduled = false;

const ROLE_PRIORITY = {
  host: 300,
  speaker: 200,
  participant: 100,
};

const MAX_ACTIVE_VIDEO_SLOTS = parsePositiveInt(process.env.MAX_ACTIVE_VIDEO_SLOTS, 3);
const VIDEO_SLOT_INVITE_TIMEOUT_MS = parsePositiveInt(process.env.VIDEO_SLOT_INVITE_TIMEOUT_MS, 10 * 1000);

function serializeSnapshot() {
  const roomEntries = [];

  for (const [roomId, state] of roomVideoSlots.entries()) {
    roomEntries.push([
      roomId,
      {
        roomId: state.roomId,
        activeUsers: Array.from(state.activeUsers.values()),
        queue: state.queue,
        invited: state.invited,
        updatedAt: state.updatedAt,
      },
    ]);
  }

  return { roomEntries };
}

function applySnapshot(payload) {
  roomVideoSlots.clear();

  const roomEntries = Array.isArray(payload?.roomEntries) ? payload.roomEntries : [];
  for (const [roomId, state] of roomEntries) {
    if (!roomId || !state || typeof state !== "object") {
      continue;
    }

    roomVideoSlots.set(roomId, {
      roomId,
      activeUsers: new Set(Array.isArray(state.activeUsers) ? state.activeUsers.filter(Boolean) : []),
      queue: Array.isArray(state.queue)
        ? state.queue
            .filter((item) => item && typeof item === "object" && item.userId)
            .map((item) => ({
              userId: item.userId,
              role: normalizeRole(item.role),
              priority: Number(item.priority) || getRolePriority(item.role),
              requestedAt: Number(item.requestedAt) || Date.now(),
            }))
        : [],
      invited:
        state.invited && state.invited.userId
          ? {
              userId: state.invited.userId,
              role: normalizeRole(state.invited.role),
              priority: Number(state.invited.priority) || getRolePriority(state.invited.role),
              invitedAt: Number(state.invited.invitedAt) || Date.now(),
              expiresAt: Number(state.invited.expiresAt) || Date.now() + VIDEO_SLOT_INVITE_TIMEOUT_MS,
            }
          : null,
      updatedAt: Number(state.updatedAt) || Date.now(),
    });
  }
}

async function persistSnapshot() {
  const payload = JSON.stringify(serializeSnapshot());
  await runValkeyCommand((client) => client.set(VIDEO_SLOT_SNAPSHOT_KEY, payload));
}

function schedulePersistSnapshot() {
  if (persistScheduled) {
    return;
  }

  persistScheduled = true;
  setTimeout(async () => {
    persistScheduled = false;
    await persistSnapshot();
  }, 0);
}

async function initializeVideoSlotStore() {
  if (initialized) {
    return;
  }

  if (!initializingPromise) {
    initializingPromise = (async () => {
      const payload = await runValkeyCommand((client) => client.get(VIDEO_SLOT_SNAPSHOT_KEY));

      if (typeof payload === "string" && payload.trim()) {
        try {
          applySnapshot(JSON.parse(payload));
        } catch (error) {
          console.warn("[videoSlotService] Invalid Valkey snapshot. Falling back to memory.", error);
        }
      }

      initialized = true;
    })().finally(() => {
      initializingPromise = null;
    });
  }

  await initializingPromise;
}

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
  return true;
}

function createInviteFromQueueHead(state, now) {
  if (state.invited || state.activeUsers.size >= MAX_ACTIVE_VIDEO_SLOTS) {
    return false;
  }

  const next = state.queue.shift();
  if (!next) {
    return false;
  }

  state.invited = {
    userId: next.userId,
    role: next.role,
    priority: next.priority,
    invitedAt: now,
    expiresAt: now + VIDEO_SLOT_INVITE_TIMEOUT_MS,
  };
  state.updatedAt = now;
  return true;
}

function processInviteTimeout(state, now) {
  if (!state.invited) {
    return false;
  }

  if (state.invited.expiresAt > now) {
    return false;
  }

  const timedOutInvite = state.invited;
  state.invited = null;

  enqueueUser(state, timedOutInvite.userId, timedOutInvite.role, now, {
    requestedAt: now,
  });
  return true;
}

function tickRoomState(state, now) {
  const timeoutChanged = processInviteTimeout(state, now);
  const inviteChanged = createInviteFromQueueHead(state, now);
  return timeoutChanged || inviteChanged;
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
  const changed = tickRoomState(state, now);
  const snapshot = toVideoSlotSnapshot(state, userId);
  cleanupRoomState(roomId);
  if (changed) {
    schedulePersistSnapshot();
  }
  return snapshot;
}

function requestVideoSlot({ roomId, userId, role, now = Date.now() }) {
  const state = getOrCreateRoomState(roomId);
  let changed = tickRoomState(state, now);

  if (state.activeUsers.has(userId)) {
    if (changed) {
      schedulePersistSnapshot();
    }
    return toVideoSlotSnapshot(state, userId);
  }

  if (state.invited && state.invited.userId === userId) {
    if (changed) {
      schedulePersistSnapshot();
    }
    return toVideoSlotSnapshot(state, userId);
  }

  if (state.activeUsers.size < MAX_ACTIVE_VIDEO_SLOTS && !state.invited && state.queue.length === 0) {
    state.activeUsers.add(userId);
    state.updatedAt = now;
    schedulePersistSnapshot();
    return toVideoSlotSnapshot(state, userId);
  }

  changed = enqueueUser(state, userId, role, now) || changed;
  changed = tickRoomState(state, now) || changed;
  if (changed) {
    schedulePersistSnapshot();
  }
  return toVideoSlotSnapshot(state, userId);
}

function acceptVideoSlotInvite({ roomId, userId, now = Date.now() }) {
  const state = getOrCreateRoomState(roomId);
  let changed = tickRoomState(state, now);

  if (state.activeUsers.has(userId)) {
    if (changed) {
      schedulePersistSnapshot();
    }
    return {
      ok: true,
      snapshot: toVideoSlotSnapshot(state, userId),
    };
  }

  if (!state.invited || state.invited.userId !== userId) {
    if (changed) {
      schedulePersistSnapshot();
    }
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
    changed = true;
    changed = tickRoomState(state, now) || changed;
    if (changed) {
      schedulePersistSnapshot();
    }
    return {
      ok: false,
      error: "Video slots are full",
      snapshot: toVideoSlotSnapshot(state, userId),
    };
  }

  state.activeUsers.add(userId);
  state.invited = null;
  state.updatedAt = now;
  changed = true;
  changed = tickRoomState(state, now) || changed;
  if (changed) {
    schedulePersistSnapshot();
  }

  return {
    ok: true,
    snapshot: toVideoSlotSnapshot(state, userId),
  };
}

function releaseVideoSlot({ roomId, userId, now = Date.now() }) {
  const state = getOrCreateRoomState(roomId);
  let changed = tickRoomState(state, now);

  const wasActive = state.activeUsers.delete(userId);
  const removedFromQueue = removeFromQueue(state, userId);
  const wasInvited = Boolean(state.invited && state.invited.userId === userId);

  if (wasInvited) {
    state.invited = null;
  }

  if (wasActive || removedFromQueue || wasInvited) {
    state.updatedAt = now;
    changed = true;
  }

  if (wasActive || wasInvited) {
    changed = tickRoomState(state, now) || changed;
  }

  const snapshot = toVideoSlotSnapshot(state, userId);
  cleanupRoomState(roomId);

  if (changed) {
    schedulePersistSnapshot();
  }

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
  if (roomVideoSlots.delete(roomId)) {
    schedulePersistSnapshot();
  }
}

module.exports = {
  initializeVideoSlotStore,
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
