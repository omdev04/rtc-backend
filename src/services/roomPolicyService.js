const roomPolicies = new Map();

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
  return roomPolicies.delete(roomId);
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
  upsertRoomPolicy,
  getRoomPolicy,
  addAllowedUsersToRoomPolicy,
  isUserAuthorizedForRoom,
  deleteRoomPolicy,
  serializeRoomPolicy,
};
