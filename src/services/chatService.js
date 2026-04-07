const { buildValkeyKey, runValkeyCommand } = require("./valkeyService");

const roomMessages = new Map();
const MAX_MESSAGES_PER_ROOM = 200;
const CHAT_SNAPSHOT_KEY = buildValkeyKey("chat:snapshot:v1");

let initialized = false;
let initializingPromise = null;
let persistScheduled = false;

function serializeSnapshot() {
  return {
    roomEntries: Array.from(roomMessages.entries()),
  };
}

function applySnapshot(payload) {
  roomMessages.clear();
  const roomEntries = Array.isArray(payload?.roomEntries) ? payload.roomEntries : [];

  for (const [roomId, messages] of roomEntries) {
    if (!roomId || !Array.isArray(messages)) {
      continue;
    }

    const normalizedMessages = messages
      .filter((item) => item && typeof item === "object")
      .slice(-MAX_MESSAGES_PER_ROOM)
      .map((item) => ({
        id: item.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        roomId,
        userId: item.userId || "unknown",
        message: String(item.message || ""),
        createdAt: Number(item.createdAt) || Date.now(),
      }));

    if (normalizedMessages.length > 0) {
      roomMessages.set(roomId, normalizedMessages);
    }
  }
}

async function persistSnapshot() {
  const payload = JSON.stringify(serializeSnapshot());
  await runValkeyCommand((client) => client.set(CHAT_SNAPSHOT_KEY, payload));
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

async function initializeChatStore() {
  if (initialized) {
    return;
  }

  if (!initializingPromise) {
    initializingPromise = (async () => {
      const payload = await runValkeyCommand((client) => client.get(CHAT_SNAPSHOT_KEY));

      if (typeof payload === "string" && payload.trim()) {
        try {
          applySnapshot(JSON.parse(payload));
        } catch (error) {
          console.warn("[chatService] Invalid Valkey snapshot. Falling back to memory.", error);
        }
      }

      initialized = true;
    })().finally(() => {
      initializingPromise = null;
    });
  }

  await initializingPromise;
}

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

  schedulePersistSnapshot();

  return payload;
}

function getRoomHistory(roomId, limit = 60) {
  const messages = roomMessages.get(roomId) || [];
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 60;
  return messages.slice(-safeLimit);
}

function clearRoomHistory(roomId) {
  if (roomMessages.delete(roomId)) {
    schedulePersistSnapshot();
  }
}

module.exports = {
  initializeChatStore,
  addRoomMessage,
  getRoomHistory,
  clearRoomHistory,
};
