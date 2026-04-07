const { buildValkeyKey, runValkeyCommand } = require("./valkeyService");

const roomPolicies = new Map();
const ROOM_POLICY_SNAPSHOT_KEY = buildValkeyKey("room-policy:snapshot:v1");

let initialized = false;
let initializingPromise = null;
let persistScheduled = false;

function serializeSnapshot() {
  const entries = [];

  for (const [roomId, policy] of roomPolicies.entries()) {
    entries.push([
      roomId,
      {
        roomId: policy.roomId,
        hostUserId: policy.hostUserId,
        allowedUsers: Array.from(policy.allowedUsers),
        createdAt: policy.createdAt,
        updatedAt: policy.updatedAt,
      },
    ]);
  }

  return { entries };
}

function applySnapshot(payload) {
  roomPolicies.clear();

  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  for (const [roomId, policy] of entries) {
    if (!roomId || !policy || typeof policy !== "object") {
      continue;
    }

    const allowedUsers = normalizeUserIds(policy.allowedUsers || [policy.hostUserId]);
    if (!policy.hostUserId) {
      continue;
    }

    roomPolicies.set(roomId, {
      roomId,
      hostUserId: policy.hostUserId,
      allowedUsers: new Set(allowedUsers),
      createdAt: Number(policy.createdAt) || Date.now(),
      updatedAt: Number(policy.updatedAt) || Date.now(),
    });
  }
}

async function persistSnapshot() {
  const payload = JSON.stringify(serializeSnapshot());
  await runValkeyCommand((client) => client.set(ROOM_POLICY_SNAPSHOT_KEY, payload));
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

async function initializeRoomPolicyStore() {
  if (initialized) {
    return;
  }

  if (!initializingPromise) {
    initializingPromise = (async () => {
      const payload = await runValkeyCommand((client) => client.get(ROOM_POLICY_SNAPSHOT_KEY));

      if (typeof payload === "string" && payload.trim()) {
        try {
          applySnapshot(JSON.parse(payload));
        } catch (error) {
          console.warn("[roomPolicyService] Invalid Valkey snapshot. Falling back to memory.", error);
        }
      }

      initialized = true;
    })().finally(() => {
      initializingPromise = null;
    });
  }

  await initializingPromise;
}

function normalizeUserIds(userIds = []) {
  return Array.from(
    new Set(
      userIds
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function upsertRoomPolicy({ roomId, hostUserId, allowedUserIds = [] }) {
  const normalizedAllowed = normalizeUserIds([hostUserId, ...allowedUserIds]);

  const existing = roomPolicies.get(roomId);
  const now = Date.now();

  const policy = {
    roomId,
    hostUserId,
    allowedUsers: new Set(normalizedAllowed),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  roomPolicies.set(roomId, policy);
  schedulePersistSnapshot();
  return policy;
}

function getRoomPolicy(roomId) {
  return roomPolicies.get(roomId) || null;
}

function addAllowedUsersToRoomPolicy(roomId, userIds = []) {
  const policy = getRoomPolicy(roomId);
  if (!policy) {
    return null;
  }

  const normalized = normalizeUserIds(userIds);
  for (const userId of normalized) {
    policy.allowedUsers.add(userId);
  }
  policy.updatedAt = Date.now();
  schedulePersistSnapshot();
  return policy;
}

function isUserAuthorizedForRoom(roomId, userId) {
  const policy = getRoomPolicy(roomId);
  if (!policy) {
    return false;
  }

  return policy.allowedUsers.has(userId);
}

function deleteRoomPolicy(roomId) {
  const deleted = roomPolicies.delete(roomId);
  if (deleted) {
    schedulePersistSnapshot();
  }
  return deleted;
}

function serializeRoomPolicy(policy) {
  if (!policy) {
    return null;
  }

  return {
    roomId: policy.roomId,
    hostUserId: policy.hostUserId,
    allowedUsers: Array.from(policy.allowedUsers),
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

module.exports = {
  initializeRoomPolicyStore,
  upsertRoomPolicy,
  getRoomPolicy,
  addAllowedUsersToRoomPolicy,
  isUserAuthorizedForRoom,
  deleteRoomPolicy,
  serializeRoomPolicy,
};
