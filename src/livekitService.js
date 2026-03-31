const { AccessToken } = require("livekit-server-sdk");

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

function normalizeLiveKitUrl(rawValue) {
  const candidate = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!candidate) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("LIVEKIT_URL is invalid. Expected a valid ws/wss (or http/https) URL.");
  }

  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("LIVEKIT_URL must use ws:// or wss:// protocol.");
  }

  parsed.hash = "";
  parsed.search = "";
  const serialized = parsed.toString();
  return serialized.endsWith("/") ? serialized.slice(0, -1) : serialized;
}

const LIVEKIT_URL = normalizeLiveKitUrl(process.env.LIVEKIT_URL);

function assertLiveKitConfig() {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
    throw new Error(
      "Missing LiveKit configuration. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL."
    );
  }
}

async function createJoinToken(roomId, userId) {
  assertLiveKitConfig();

  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    ttl: "1h",
  });

  token.addGrant({
    roomJoin: true,
    room: roomId,
  });

  return await token.toJwt();
}

function getLiveKitUrl() {
  assertLiveKitConfig();
  return LIVEKIT_URL;
}

module.exports = {
  createJoinToken,
  getLiveKitUrl,
  assertLiveKitConfig,
};
