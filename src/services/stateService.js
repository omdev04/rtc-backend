const rooms = new Map();
const globalUsers = new Set();

// Tracks how many rooms each user is present in to keep globalUsers accurate.
const userRoomCounts = new Map();
const roomUserLastSeen = new Map();

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

function addUserToRoom(roomId, userId) {
  const room = getOrCreateRoom(roomId);
  const wasInRoom = room.has(userId);
  room.add(userId);
  markUserSeen(roomId, userId);

  if (!wasInRoom) {
    const nextCount = (userRoomCounts.get(userId) || 0) + 1;
    userRoomCounts.set(userId, nextCount);
    globalUsers.add(userId);
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
  getOrCreateRoom,
  isUserInRoom,
  getRoomUsers,
  addUserToRoom,
  touchUserInRoom,
  removeUserFromRoom,
  pruneInactiveParticipants,
  getHealthSnapshot,
};
