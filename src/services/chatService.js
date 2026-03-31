const roomMessages = new Map();
const MAX_MESSAGES_PER_ROOM = 200;

function getRoomMessages(roomId) {
  if (!roomMessages.has(roomId)) {
    roomMessages.set(roomId, []);
  }
  return roomMessages.get(roomId);
}

function addRoomMessage({ roomId, userId, message }) {
  const messages = getRoomMessages(roomId);
  const payload = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    roomId,
    userId,
    message,
    createdAt: Date.now(),
  };

  messages.push(payload);

  if (messages.length > MAX_MESSAGES_PER_ROOM) {
    messages.splice(0, messages.length - MAX_MESSAGES_PER_ROOM);
  }

  return payload;
}

function getRoomHistory(roomId, limit = 60) {
  const messages = roomMessages.get(roomId) || [];
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 60;
  return messages.slice(-safeLimit);
}

function clearRoomHistory(roomId) {
  roomMessages.delete(roomId);
}

module.exports = {
  addRoomMessage,
  getRoomHistory,
  clearRoomHistory,
};
