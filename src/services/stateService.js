const { buildValkeyKey, runValkeyCommand } = require("./valkeyService");

const rooms = new Map();
const globalUsers = new Set();

// Tracks how many rooms each user is present in to keep globalUsers accurate.
const userRoomCounts = new Map();
const roomUserLastSeen = new Map();

const STATE_SNAPSHOT_KEY = buildValkeyKey("state:snapshot:v1");

let initialized = false;
let initializingPromise = null;
let persistScheduled = false;

function serializeSnapshot() {
  const roomEntries = [];
  for (const [roomId, userSet] of rooms.entries()) {
    roomEntries.push([roomId, Array.from(userSet.values())]);
  }

  const roomLastSeenEntries = [];
  for (const [roomId, lastSeenMap] of roomUserLastSeen.entries()) {
    roomLastSeenEntries.push([roomId, Array.from(lastSeenMap.entries())]);
  }

  return {
    roomEntries,
    userRoomCountEntries: Array.from(userRoomCounts.entries()),
    roomLastSeenEntries,
  };
}

function applySnapshot(payload) {
  rooms.clear();
  globalUsers.clear();
  userRoomCounts.clear();
  roomUserLastSeen.clear();

  const roomEntries = Array.isArray(payload?.roomEntries) ? payload.roomEntries : [];
  for (const [roomId, users] of roomEntries) {
    if (!roomId || !Array.isArray(users)) {
      continue;
    }
    rooms.set(roomId, new Set(users.filter(Boolean)));
  }

  const userRoomCountEntries = Array.isArray(payload?.userRoomCountEntries)
    ? payload.userRoomCountEntries
    : [];
  for (const [userId, count] of userRoomCountEntries) {
    const normalizedCount = Number(count);
    if (!userId || !Number.isFinite(normalizedCount) || normalizedCount <= 0) {
      continue;
    }
    userRoomCounts.set(userId, normalizedCount);
    globalUsers.add(userId);
  }

  const roomLastSeenEntries = Array.isArray(payload?.roomLastSeenEntries)
    ? payload.roomLastSeenEntries
    : [];
  for (const [roomId, entries] of roomLastSeenEntries) {
    if (!roomId || !Array.isArray(entries)) {
      continue;
    }

    const map = new Map();
    for (const [userId, timestamp] of entries) {
      const numericTs = Number(timestamp);
      if (!userId || !Number.isFinite(numericTs) || numericTs <= 0) {
        continue;
      }
      map.set(userId, numericTs);
    }

    if (map.size > 0) {
      roomUserLastSeen.set(roomId, map);
    }
  }

  // Reconcile derived sets in case snapshot is partial or stale.
  for (const [roomId, users] of rooms.entries()) {
    if (users.size === 0) {
      rooms.delete(roomId);
      roomUserLastSeen.delete(roomId);
      continue;
    }

    for (const userId of users.values()) {
      if (!userRoomCounts.has(userId)) {
        userRoomCounts.set(userId, 1);
      }
      globalUsers.add(userId);
    }
  }
}

async function persistSnapshot() {
  const snapshot = serializeSnapshot();
  const payload = JSON.stringify(snapshot);

  await runValkeyCommand((client) => client.set(STATE_SNAPSHOT_KEY, payload));
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

async function initializeStateStore() {
  if (initialized) {
    return;
  }

  if (!initializingPromise) {
    initializingPromise = (async () => {
      const payload = await runValkeyCommand((client) => client.get(STATE_SNAPSHOT_KEY));

      if (typeof payload === "string" && payload.trim()) {
        try {
          applySnapshot(JSON.parse(payload));
        } catch (error) {
          console.warn("[stateService] Invalid Valkey snapshot. Falling back to empty state.", error);
        }
      }

      initialized = true;
    })().finally(() => {
      initializingPromise = null;
    });
  }

  await initializingPromise;
}

function getOrCreateRoomLastSeen(roomId) {
  if (!roomUserLastSeen.has(roomId)) {
    roomUserLastSeen.set(roomId, new Map());
  }
  return roomUserLastSeen.get(roomId);
}

function markUserSeen(roomId, userId, timestamp = Date.now()) {
  const roomLastSeen = getOrCreateRoomLastSeen(roomId);
  roomLastSeen.set(userId, timestamp);
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

function isUserInRoom(roomId, userId) {
  const room = rooms.get(roomId);
  return !!room && room.has(userId);
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return [];
  }

  return Array.from(room.values());
}

function getRoomSize(roomId) {
  const room = rooms.get(roomId);
  return room ? room.size : 0;
}

function isKnownGlobalUser(userId) {
  return globalUsers.has(userId);
}

function getGlobalUsersCount() {
  return globalUsers.size;
}

function addUserToRoom(roomId, userId) {
  const room = getOrCreateRoom(roomId);
  const wasInRoom = room.has(userId);
  room.add(userId);
  markUserSeen(roomId, userId);

  if (!wasInRoom) {
    const nextCount = (userRoomCounts.get(userId) || 0) + 1;
    userRoomCounts.set(userId, nextCount);
    globalUsers.add(userId);
    schedulePersistSnapshot();
  }

  return {
    added: !wasInRoom,
    alreadyInRoom: wasInRoom,
  };
}

function touchUserInRoom(roomId, userId) {
  if (!isUserInRoom(roomId, userId)) {
    return false;
  }

  // Keep heartbeats in memory; persisting every poll would flood Valkey commands.
  markUserSeen(roomId, userId);
  return true;
}

function removeUserFromRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) {
    return { removedFromRoom: false, roomDeleted: false };
  }

  const removedFromRoom = room.delete(userId);
  let roomDeleted = false;

  const roomLastSeen = roomUserLastSeen.get(roomId);
  if (roomLastSeen) {
    roomLastSeen.delete(userId);
    if (roomLastSeen.size === 0) {
      roomUserLastSeen.delete(roomId);
    }
  }

  if (room.size === 0) {
    rooms.delete(roomId);
    roomUserLastSeen.delete(roomId);
    roomDeleted = true;
  }

  if (removedFromRoom) {
    const nextCount = (userRoomCounts.get(userId) || 1) - 1;
    if (nextCount <= 0) {
      userRoomCounts.delete(userId);
      globalUsers.delete(userId);
    } else {
      userRoomCounts.set(userId, nextCount);
    }

    schedulePersistSnapshot();
  }

  return { removedFromRoom, roomDeleted };
}

function pruneInactiveParticipants(options = {}) {
  const maxIdleMs = Number(options.maxIdleMs || 0);
  if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) {
    return {
      prunedUsers: 0,
      prunedRooms: 0,
      prunedRoomIds: [],
      removedMembers: [],
    };
  }

  const now = Number(options.now || Date.now());
  const staleMembers = [];

  for (const [roomId, users] of rooms.entries()) {
    const roomLastSeen = roomUserLastSeen.get(roomId);

    for (const userId of users.values()) {
      const lastSeenAt = roomLastSeen ? roomLastSeen.get(userId) : null;
      const ageMs = Number.isFinite(lastSeenAt) ? now - lastSeenAt : Number.POSITIVE_INFINITY;

      if (ageMs > maxIdleMs) {
        staleMembers.push({ roomId, userId, ageMs });
      }
    }
  }

  const prunedRoomIds = new Set();
  const removedMembers = [];

  for (const staleMember of staleMembers) {
    const result = removeUserFromRoom(staleMember.roomId, staleMember.userId);
    if (!result.removedFromRoom) {
      continue;
    }

    removedMembers.push({
      roomId: staleMember.roomId,
      userId: staleMember.userId,
      ageMs: staleMember.ageMs,
    });

    if (result.roomDeleted) {
      prunedRoomIds.add(staleMember.roomId);
    }
  }

  return {
    prunedUsers: removedMembers.length,
    prunedRooms: prunedRoomIds.size,
    prunedRoomIds: Array.from(prunedRoomIds),
    removedMembers,
  };
}

function getHealthSnapshot() {
  const usersPerRoom = {};
  for (const [roomId, userSet] of rooms.entries()) {
    usersPerRoom[roomId] = userSet.size;
  }

  let oldestPresenceAgeMs = 0;
  const now = Date.now();

  for (const roomLastSeen of roomUserLastSeen.values()) {
    for (const lastSeenAt of roomLastSeen.values()) {
      if (!Number.isFinite(lastSeenAt)) {
        continue;
      }
      const ageMs = Math.max(0, now - lastSeenAt);
      if (ageMs > oldestPresenceAgeMs) {
        oldestPresenceAgeMs = ageMs;
      }
    }
  }

  return {
    totalRooms: rooms.size,
    totalUsers: globalUsers.size,
    trackedUsers: userRoomCounts.size,
    trackedRoomHeartbeats: roomUserLastSeen.size,
    oldestPresenceAgeMs,
    usersPerRoom,
  };
}

module.exports = {
  rooms,
  globalUsers,
  initializeStateStore,
  getOrCreateRoom,
  isUserInRoom,
  getRoomUsers,
  getRoomSize,
  isKnownGlobalUser,
  getGlobalUsersCount,
  addUserToRoom,
  touchUserInRoom,
  removeUserFromRoom,
  pruneInactiveParticipants,
  getHealthSnapshot,
};
