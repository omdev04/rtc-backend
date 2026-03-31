require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { ExpressPeerServer } = require("peer");
const path = require("path");

const rtcRoutes = require("./routes/rtcRoutes");
const { createRateLimiter } = require("./services/rateLimitService");
const { clearRoomHistory } = require("./services/chatService");
const { deleteRoomPolicy } = require("./services/roomPolicyService");
const { getHealthSnapshot, pruneInactiveParticipants } = require("./services/stateService");

const app = express();

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const PORT = Math.floor(toPositiveNumber(process.env.PORT, 3001));
const PEER_SERVER_PATH = normalizePeerServerPath(process.env.PEER_SERVER_PATH || "/peerjs");
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const FRONTEND_USERNAME = process.env.FRONTEND_USERNAME || "admin";
const FRONTEND_PASSWORD = process.env.FRONTEND_PASSWORD || "admin123";
const FRONTEND_SECRET = process.env.FRONTEND_SECRET || "your-secret-key-change-this";
const AUTH_TOKEN_TTL_MS = Math.floor(toPositiveNumber(process.env.AUTH_TOKEN_TTL_MS, 12 * 60 * 60 * 1000));
const AUTH_TOKEN_CLEANUP_INTERVAL_MS = Math.floor(
  toPositiveNumber(process.env.AUTH_TOKEN_CLEANUP_INTERVAL_MS, 5 * 60 * 1000),
);
const AUTH_MAX_TOKENS = Math.max(100, Math.floor(toPositiveNumber(process.env.AUTH_MAX_TOKENS, 5000)));

const RATE_LIMIT_MAX_KEYS = Math.max(100, Math.floor(toPositiveNumber(process.env.RATE_LIMIT_MAX_KEYS, 5000)));
const GLOBAL_RATE_LIMIT_MAX_REQUESTS = Math.floor(
  toPositiveNumber(process.env.GLOBAL_RATE_LIMIT_MAX_REQUESTS, 120),
);
const JOIN_LEAVE_RATE_LIMIT_MAX_REQUESTS = Math.floor(
  toPositiveNumber(process.env.JOIN_LEAVE_RATE_LIMIT_MAX_REQUESTS, 30),
);
const ROOM_ADMIN_RATE_LIMIT_MAX_REQUESTS = Math.floor(
  toPositiveNumber(process.env.ROOM_ADMIN_RATE_LIMIT_MAX_REQUESTS, 180),
);
const PARTICIPANTS_RATE_LIMIT_MAX_REQUESTS = Math.floor(
  toPositiveNumber(process.env.PARTICIPANTS_RATE_LIMIT_MAX_REQUESTS, 240),
);
const CHAT_RATE_LIMIT_MAX_REQUESTS = Math.floor(toPositiveNumber(process.env.CHAT_RATE_LIMIT_MAX_REQUESTS, 120));
const PUSH_RATE_LIMIT_MAX_REQUESTS = Math.floor(toPositiveNumber(process.env.PUSH_RATE_LIMIT_MAX_REQUESTS, 30));

const RTC_PRESENCE_MAX_IDLE_MS = Math.floor(
  toPositiveNumber(process.env.RTC_PRESENCE_MAX_IDLE_MS, 90 * 1000),
);
const RTC_PRESENCE_REAPER_INTERVAL_MS = Math.floor(
  toPositiveNumber(process.env.RTC_PRESENCE_REAPER_INTERVAL_MS, 30 * 1000),
);

const validTokens = new Map();
let authTokenCleanupInterval = null;
let presenceReaperInterval = null;

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

function getRequestPath(req) {
  const rawPath = typeof req.originalUrl === "string"
    ? req.originalUrl
    : (typeof req.url === "string" ? req.url : req.path);

  if (typeof rawPath !== "string") {
    return "";
  }

  return rawPath.split("?")[0];
}

function isParticipantsRequest(req) {
  if (req.method !== "GET") {
    return false;
  }

  return /^\/room\/[^/]+\/participants$/.test(getRequestPath(req));
}

function getTokenFromAuthorizationHeader(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return "";
  }
  return authHeader.substring(7).trim();
}

function pruneExpiredTokens(now = Date.now()) {
  let removed = 0;

  for (const [token, tokenEntry] of validTokens.entries()) {
    if (tokenEntry.expiresAt <= now) {
      validTokens.delete(token);
      removed += 1;
    }
  }

  if (validTokens.size > AUTH_MAX_TOKENS) {
    const overflowEntries = Array.from(validTokens.entries())
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
      .slice(0, validTokens.size - AUTH_MAX_TOKENS);

    for (const [token] of overflowEntries) {
      validTokens.delete(token);
      removed += 1;
    }
  }

  return removed;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function storeToken(token) {
  const now = Date.now();
  validTokens.set(token, {
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + AUTH_TOKEN_TTL_MS,
  });

  pruneExpiredTokens(now);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAny = allowedOrigins.includes("*");
  const isAllowedOrigin = typeof origin === "string" && (allowAny || allowedOrigins.includes(origin));

  if (isAllowedOrigin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Content-Type, x-rtc-admin-key, x-peerjs-key");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

const globalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: GLOBAL_RATE_LIMIT_MAX_REQUESTS,
  maxEntries: RATE_LIMIT_MAX_KEYS,
});
const joinLeaveLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: JOIN_LEAVE_RATE_LIMIT_MAX_REQUESTS,
  maxEntries: RATE_LIMIT_MAX_KEYS,
});
const roomAdminLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: ROOM_ADMIN_RATE_LIMIT_MAX_REQUESTS,
  maxEntries: RATE_LIMIT_MAX_KEYS,
});
const participantsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: PARTICIPANTS_RATE_LIMIT_MAX_REQUESTS,
  maxEntries: RATE_LIMIT_MAX_KEYS,
  keyGenerator: (req) => {
    const userId = typeof req.query?.userId === "string" ? req.query.userId.trim() : "";
    if (userId) {
      return `participants:${userId}`;
    }
    return req.ip || req.socket?.remoteAddress || "unknown";
  },
});
const chatLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: CHAT_RATE_LIMIT_MAX_REQUESTS,
  maxEntries: RATE_LIMIT_MAX_KEYS,
});
const pushLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: PUSH_RATE_LIMIT_MAX_REQUESTS,
  maxEntries: RATE_LIMIT_MAX_KEYS,
});

app.use((req, res, next) => {
  const requestPath = getRequestPath(req);

  if (requestPath.startsWith(PEER_SERVER_PATH)) {
    return next();
  }

  if (isParticipantsRequest(req)) {
    return next();
  }

  return globalLimiter(req, res, next);
});
app.use("/join", joinLeaveLimiter);
app.use("/leave", joinLeaveLimiter);
app.use("/room", (req, res, next) => {
  if (isParticipantsRequest(req)) {
    return participantsLimiter(req, res, next);
  }
  return roomAdminLimiter(req, res, next);
});
app.use("/chat", chatLimiter);
app.use("/push", pushLimiter);

app.use(express.static(path.join(__dirname, "../public")));

function verifyToken(req, res, next) {
  const token = getTokenFromAuthorizationHeader(req);
  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  const tokenEntry = validTokens.get(token);
  if (!tokenEntry) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const now = Date.now();
  if (tokenEntry.expiresAt <= now) {
    validTokens.delete(token);
    return res.status(401).json({ error: "Token expired" });
  }

  // Sliding expiration prevents long sessions from failing due stale auth token.
  tokenEntry.lastSeenAt = now;
  tokenEntry.expiresAt = now + AUTH_TOKEN_TTL_MS;
  return next();
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  if (username === FRONTEND_USERNAME && password === FRONTEND_PASSWORD) {
    const token = generateToken();
    storeToken(token);
    return res.json({ token, expiresInMs: AUTH_TOKEN_TTL_MS });
  }

  return res.status(401).json({ error: "Invalid credentials" });
});

app.get("/api/status", verifyToken, (_req, res) => {
  res.json({
    serverStatus: "Running",
    activeAuthTokens: validTokens.size,
  });
});

app.get("/api/health", verifyToken, (_req, res) => {
  res.json({
    ...getHealthSnapshot(),
    auth: {
      activeTokens: validTokens.size,
      tokenTtlMs: AUTH_TOKEN_TTL_MS,
      maxTokens: AUTH_MAX_TOKENS,
    },
    presence: {
      maxIdleMs: RTC_PRESENCE_MAX_IDLE_MS,
      reaperIntervalMs: RTC_PRESENCE_REAPER_INTERVAL_MS,
    },
  });
});

app.get("/api/logout", verifyToken, (req, res) => {
  const token = getTokenFromAuthorizationHeader(req);
  if (token) {
    validTokens.delete(token);
  }

  res.json({ ok: true });
});

function startMaintenanceJobs() {
  authTokenCleanupInterval = setInterval(() => {
    const removed = pruneExpiredTokens();
    if (removed > 0) {
      console.log(`[auth] cleaned ${removed} expired token(s)`);
    }
  }, AUTH_TOKEN_CLEANUP_INTERVAL_MS);
  authTokenCleanupInterval.unref?.();

  presenceReaperInterval = setInterval(() => {
    const result = pruneInactiveParticipants({ maxIdleMs: RTC_PRESENCE_MAX_IDLE_MS });

    if (result.prunedRooms > 0) {
      for (const roomId of result.prunedRoomIds) {
        deleteRoomPolicy(roomId);
        clearRoomHistory(roomId);
      }
    }

    if (result.prunedUsers > 0 || result.prunedRooms > 0) {
      console.log(
        `[presence] pruned ${result.prunedUsers} stale participant(s) across ${result.prunedRooms} room(s)`,
      );
    }
  }, RTC_PRESENCE_REAPER_INTERVAL_MS);
  presenceReaperInterval.unref?.();
}

const server = http.createServer(app);
const peerServer = ExpressPeerServer(server, {
  path: "/",
  proxied: true,
  allow_discovery: false,
});

app.use(PEER_SERVER_PATH, peerServer);
app.use(rtcRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    error: "Internal server error",
  });
});
peerServer.on("connection", (client) => {
  const id = typeof client?.getId === "function" ? client.getId() : "unknown";
  console.log(`[peer] connected: ${id}`);
});

peerServer.on("disconnect", (client) => {
  const id = typeof client?.getId === "function" ? client.getId() : "unknown";
  console.log(`[peer] disconnected: ${id}`);
});

startMaintenanceJobs();

function stopMaintenanceJobs() {
  if (authTokenCleanupInterval) {
    clearInterval(authTokenCleanupInterval);
    authTokenCleanupInterval = null;
  }

  if (presenceReaperInterval) {
    clearInterval(presenceReaperInterval);
    presenceReaperInterval = null;
  }
}

server.on("error", (error) => {
  console.error("HTTP server error:", error);
  shutdown("serverError", 1);
});

server.listen(PORT, () => {
  console.log(`RTC backend listening on port ${PORT}`);
  console.log(`PeerJS signaling available at ${PEER_SERVER_PATH}`);
});

let shuttingDown = false;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down gracefully...`);

  stopMaintenanceJobs();

  if (!server.listening) {
    process.exit(exitCode);
    return;
  }

  const forceShutdownTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 10 * 1000);
  forceShutdownTimer.unref?.();

  server.close((error) => {
    clearTimeout(forceShutdownTimer);

    if (error) {
      if (error.code === "ERR_SERVER_NOT_RUNNING") {
        process.exit(exitCode);
        return;
      }

      console.error("Error while closing server:", error);
      process.exit(1);
      return;
    }

    process.exit(exitCode);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

void FRONTEND_SECRET;

module.exports = app;
