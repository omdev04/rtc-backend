# RTC Backend (PeerJS + Valkey-Optional State)

Lightweight control layer for PeerJS-based browser-to-browser calls using Node.js + Express.

## Stack

- Node.js
- Express
- peer
- dotenv
- ioredis (Valkey/Redis compatible)

## Persistence Model

This backend supports two runtime modes:

- Valkey mode (recommended for production):
  - Room/user presence, room policy, chat history, video-slot state, and rate limits are shared and survive restarts.
- In-memory fallback mode:
  - If Valkey is not configured or temporarily unavailable, backend continues running with in-memory state.

Notes:

- In-memory fallback resets on restart.
- Stale participant cleanup is active in both modes.

## Environment

Copy `.env.example` to `.env` and fill values:

- PEER_SERVER_PATH=/peerjs
- PEER_SERVER_KEY=peerjs
- MAX_USERS_PER_ROOM=12
- MAX_GLOBAL_USERS=100
- RTC_ADMIN_KEY=change_this_admin_key
- VAPID_PUBLIC_KEY=<public key>
- VAPID_PRIVATE_KEY=<private key>
- VAPID_SUBJECT=mailto:security@example.com
- PORT=3001
- VALKEY_ENABLED=true
- VALKEY_DRIVER=rest
- VALKEY_REST_URL=https://light-snake-92731.upstash.io
- VALKEY_REST_TOKEN=<upstash token>
- VALKEY_URL=redis://:your_valkey_password@zara2122-tagvelky.hf.space:6379/0
- VALKEY_KEY_PREFIX=tagowls:rtc

Optional hardening knobs:

- AUTH_TOKEN_TTL_MS=43200000
- RTC_PRESENCE_MAX_IDLE_MS=90000
- RTC_PRESENCE_REAPER_INTERVAL_MS=30000
- PARTICIPANTS_RATE_LIMIT_MAX_REQUESTS=240
- RATE_LIMIT_MAX_KEYS=5000
- MAX_ACTIVE_VIDEO_SLOTS=3
- VIDEO_SLOT_INVITE_TIMEOUT_MS=10000
- VALKEY_CONNECT_TIMEOUT_MS=2500

If `VALKEY_DRIVER=rest`, backend uses Upstash REST credentials (`VALKEY_REST_URL`, `VALKEY_REST_TOKEN`).
If `VALKEY_DRIVER=tcp` or `auto` without REST config, backend uses `VALKEY_URL` or `VALKEY_HOST` + `VALKEY_PORT` + `VALKEY_PASSWORD`.

Generate VAPID keys once (free web push):

```bash
npx web-push generate-vapid-keys --json
```

## Run

```bash
npm install
node server.js
```

## APIs

### POST /room/authorize

Header:

`x-rtc-admin-key: <RTC_ADMIN_KEY>`

Body:

```json
{
  "roomId": "room_123",
  "hostUserId": "user_host",
  "allowedUserIds": ["user_a", "user_b"]
}
```

Behavior:

- Creates or updates room-level authorization policy.
- Adds `hostUserId` automatically into allowed users.
- `/join` is denied until room is authorized.

### POST /join

Body:

```json
{
  "roomId": "room_123",
  "userId": "user_456"
}
```

Behavior:

- Creates room if missing
- Requires room policy created by `/room/authorize`
- Allows only users included in room policy
- If user already exists in room, returns `alreadyJoined=true`
- Enforces room and global user limits
- Returns PeerJS connection config + peerId

Response:

```json
{
  "ok": true,
  "peerId": "user_456",
  "peerConfig": {
    "key": "peerjs",
    "path": "/peerjs"
  }
}
```

### GET /room/:roomId/participants?userId=user_456

Behavior:

- User must be authorized and currently joined in the room.
- Returns currently joined room participants.

Response:

```json
{
  "roomId": "room_123",
  "participants": ["user_123", "user_456"]
}
```

### Video Slot Manager (max active camera publishers)

This backend includes a video slot manager (persisted in Valkey when enabled):

- Max concurrent active camera publishers: `MAX_ACTIVE_VIDEO_SLOTS` (default `3`)
- Extra camera-on requests are queued using priority + FIFO:
  - `host` > `speaker` > `participant`
- When a slot frees, queue head gets a temporary invite (`VIDEO_SLOT_INVITE_TIMEOUT_MS`, default `10s`)
- If invite times out, user is re-queued and next user is promoted

Endpoints:

- `GET /room/:roomId/video-slot/status?userId=...`
- `POST /room/video-slot/request` with `{ roomId, userId, role }`
- `POST /room/video-slot/accept` with `{ roomId, userId }`
- `POST /room/video-slot/release` with `{ roomId, userId }`

### PeerJS signaling endpoint

- Signaling/WebSocket server is mounted at `PEER_SERVER_PATH` (default: `/peerjs`).
- Frontend clients connect to the same backend host/port + this path.

### POST /leave

Body:

```json
{
  "roomId": "room_123",
  "userId": "user_456"
}
```

Behavior:

- Removes user from room
- Updates global users set
- Deletes room if empty
- Clears room policy and room chat history when room becomes empty

### POST /chat/send

Body:

```json
{
  "roomId": "room_123",
  "userId": "user_456",
  "message": "Hello team"
}
```

Behavior:

- User must be authorized for room and currently joined.
- Stores room chat message (Valkey-backed when enabled, memory fallback otherwise).

### GET /chat/history?roomId=room_123&userId=user_456&limit=60

Behavior:

- User must be authorized for room.
- Returns recent room messages.

### GET /health

Response:

```json
{
  "totalRooms": 2,
  "totalUsers": 8,
  "valkey": {
    "configured": true,
    "connected": true,
    "usingFallback": false,
    "clientStatus": "ready",
    "keyPrefix": "tagowls:rtc"
  },
  "usersPerRoom": {
    "room_123": 5,
    "room_abc": 3
  }
}
```

### Web Push (Free)

This backend supports browser push notifications for meeting invites with VAPID.

Endpoints:

- `GET /push/public-key`
- `POST /push/subscribe`
- `POST /push/unsubscribe`

Security notes:

- Push payload intentionally contains minimal data (no sensitive workspace payload).
- Subscription payloads are validated strictly (https endpoint + key format checks).
- Push routes are rate-limited.
