let Redis = null;
let UpstashRedis = null;

try {
  Redis = require("ioredis");
} catch {
  console.warn("[valkey] ioredis package is not installed. Falling back to in-memory stores.");
}

try {
  ({ Redis: UpstashRedis } = require("@upstash/redis"));
} catch {
  console.warn("[valkey] @upstash/redis package is not installed. REST mode unavailable.");
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = safeTrim(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

const VALKEY_ENABLED = toBoolean(process.env.VALKEY_ENABLED, true);
const VALKEY_URL = safeTrim(process.env.VALKEY_URL);
const VALKEY_HOST = safeTrim(process.env.VALKEY_HOST || "127.0.0.1");
const HAS_EXPLICIT_HOST = safeTrim(process.env.VALKEY_HOST).length > 0;
const VALKEY_DRIVER = safeTrim(process.env.VALKEY_DRIVER || "auto").toLowerCase();
const VALKEY_REST_URL = safeTrim(process.env.VALKEY_REST_URL);
const VALKEY_REST_TOKEN = safeTrim(process.env.VALKEY_REST_TOKEN);
const VALKEY_PORT = Math.floor(toPositiveNumber(process.env.VALKEY_PORT, 6379));
const VALKEY_DB = Math.floor(toPositiveNumber(process.env.VALKEY_DB, 0));
const VALKEY_PASSWORD = safeTrim(process.env.VALKEY_PASSWORD);
const VALKEY_CONNECT_TIMEOUT_MS = Math.floor(
  toPositiveNumber(process.env.VALKEY_CONNECT_TIMEOUT_MS, 2500),
);
const VALKEY_FAIL_OPEN_AFTER_FAILURES = Math.max(
  1,
  Math.floor(toPositiveNumber(process.env.VALKEY_FAIL_OPEN_AFTER_FAILURES, 1)),
);
const VALKEY_KEY_PREFIX = safeTrim(process.env.VALKEY_KEY_PREFIX || "tagowls:rtc");

const hasTcpConnectionConfig = Boolean(VALKEY_URL || HAS_EXPLICIT_HOST);
const hasRestConnectionConfig = Boolean(VALKEY_REST_URL && VALKEY_REST_TOKEN);

function shouldUseRestDriver() {
  if (VALKEY_DRIVER === "rest" || VALKEY_DRIVER === "upstash") {
    return true;
  }

  if (VALKEY_DRIVER === "tcp" || VALKEY_DRIVER === "redis") {
    return false;
  }

  return hasRestConnectionConfig;
}

const useRestDriver = shouldUseRestDriver();
const hasConnectionConfig = useRestDriver
  ? hasRestConnectionConfig
  : hasTcpConnectionConfig;

let client = null;
let connectPromise = null;
let isDisabled = !VALKEY_ENABLED
  || (useRestDriver ? !UpstashRedis : !Redis)
  || !hasConnectionConfig;
let disableReason = !VALKEY_ENABLED
  ? "disabled by VALKEY_ENABLED"
  : useRestDriver && !UpstashRedis
    ? "@upstash/redis package missing"
    : !useRestDriver && !Redis
      ? "ioredis package missing"
    : !hasConnectionConfig
      ? "missing connection config"
      : "";
let warnCounter = 0;
let consecutiveFailures = 0;

function disableValkey(reason, error) {
  if (isDisabled) {
    return;
  }

  isDisabled = true;
  disableReason = reason;

  if (error) {
    warnValkey(`${reason}; falling back to memory`, error);
  } else {
    warnValkey(`${reason}; falling back to memory`);
  }

  try {
    client?.removeAllListeners();
    client?.disconnect();
  } catch {
    // Ignore cleanup errors.
  }
}

function buildRedisOptions() {
  const baseOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: VALKEY_CONNECT_TIMEOUT_MS,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    db: VALKEY_DB,
  };

  if (VALKEY_URL) {
    return {
      url: VALKEY_URL,
      options: baseOptions,
    };
  }

  return {
    host: VALKEY_HOST,
    port: VALKEY_PORT,
    password: VALKEY_PASSWORD || undefined,
    options: baseOptions,
  };
}

function createTcpClient() {
  const config = buildRedisOptions();

  if (config.url) {
    return new Redis(config.url, config.options);
  }

  return new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    ...config.options,
  });
}

function createRestClient() {
  const restClient = new UpstashRedis({
    url: VALKEY_REST_URL,
    token: VALKEY_REST_TOKEN,
  });

  return {
    status: "ready",
    disconnect: () => {},
    quit: async () => {},
    removeAllListeners: () => {},
    get: async (key) => restClient.get(key),
    set: async (key, value) => restClient.set(key, value),
    incr: async (key) => restClient.incr(key),
    pexpire: async (key, ms) => {
      if (typeof restClient.pexpire === "function") {
        return restClient.pexpire(key, ms);
      }

      const ttlSeconds = Math.max(1, Math.ceil(Number(ms) / 1000));
      return restClient.expire(key, ttlSeconds);
    },
    pttl: async (key) => {
      if (typeof restClient.pttl === "function") {
        return restClient.pttl(key);
      }

      if (typeof restClient.ttl === "function") {
        const ttlSeconds = await restClient.ttl(key);
        if (typeof ttlSeconds === "number") {
          if (ttlSeconds < 0) {
            return ttlSeconds;
          }
          return ttlSeconds * 1000;
        }
      }

      return -1;
    },
  };
}

function createClient() {
  if (useRestDriver) {
    return createRestClient();
  }

  return createTcpClient();
}

function warnValkey(message, error) {
  warnCounter += 1;
  if (warnCounter <= 5 || warnCounter % 25 === 0) {
    if (error) {
      console.warn(`[valkey] ${message}:`, error.message || error);
    } else {
      console.warn(`[valkey] ${message}`);
    }
  }
}

async function getClient() {
  if (isDisabled) {
    return null;
  }

  if (!client) {
    try {
      client = createClient();

      if (!useRestDriver) {
        client.on("error", (error) => {
          warnValkey("runtime error", error);

          consecutiveFailures += 1;
          if (consecutiveFailures >= VALKEY_FAIL_OPEN_AFTER_FAILURES) {
            disableValkey("too many Valkey runtime errors", error);
          }
        });
        client.on("end", () => {
          if (!isDisabled) {
            warnValkey("connection closed; using memory fallback until reconnect");
          }
        });
      }
    } catch (error) {
      disableValkey("client init failed", error);
      return null;
    }
  }

  if (useRestDriver) {
    return client;
  }

  if (client.status === "ready") {
    return client;
  }

  if (!connectPromise) {
    connectPromise = client.connect().catch((error) => {
      warnValkey("connect failed; using memory fallback", error);

      consecutiveFailures += 1;
      if (consecutiveFailures >= VALKEY_FAIL_OPEN_AFTER_FAILURES) {
        disableValkey("Valkey connect failed", error);
      }

      return null;
    }).finally(() => {
      connectPromise = null;
    });
  }

  await connectPromise;

  return client.status === "ready" ? client : null;
}

function buildValkeyKey(suffix) {
  const normalizedSuffix = safeTrim(suffix);
  return normalizedSuffix
    ? `${VALKEY_KEY_PREFIX}:${normalizedSuffix}`
    : VALKEY_KEY_PREFIX;
}

async function runValkeyCommand(command, fallbackValue = null) {
  try {
    const activeClient = await getClient();
    if (!activeClient) {
      return fallbackValue;
    }

    return await command(activeClient);
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= VALKEY_FAIL_OPEN_AFTER_FAILURES) {
      disableValkey("Valkey command failed", error);
    }

    warnValkey("command failed; using memory fallback", error);
    return fallbackValue;
  }
}

function getValkeyStatus() {
  const configured = VALKEY_ENABLED
    && (useRestDriver ? Boolean(UpstashRedis) : Boolean(Redis))
    && hasConnectionConfig;
  const connected = client?.status === "ready";

  return {
    configured,
    connected,
    usingFallback: !connected,
    driver: useRestDriver ? "rest" : "tcp",
    consecutiveFailures,
    disabledReason: isDisabled ? disableReason : "",
    clientStatus: client ? client.status : "uninitialized",
    keyPrefix: VALKEY_KEY_PREFIX,
  };
}

async function closeValkeyClient() {
  if (!client) {
    return;
  }

  try {
    await client.quit();
  } catch {
    try {
      client.disconnect();
    } catch {
      // Ignore shutdown failures.
    }
  }
}

module.exports = {
  buildValkeyKey,
  closeValkeyClient,
  getValkeyStatus,
  runValkeyCommand,
};
