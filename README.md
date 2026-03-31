# RTC Backend (PeerJS + In-Memory State)

Lightweight control layer for PeerJS-based browser-to-browser calls using Node.js + Express.

## Stack

- Node.js
- Express
- peer
- dotenv

## Important Limitation

This backend uses in-memory storage:

- All room/user state resets on restart
- Not suitable for multi-instance horizontal scaling
- Includes stale participant cleanup for long-running calls

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

Optional hardening knobs:

- AUTH_TOKEN_TTL_MS=43200000
- RTC_PRESENCE_MAX_IDLE_MS=90000
- RTC_PRESENCE_REAPER_INTERVAL_MS=30000
- PARTICIPANTS_RATE_LIMIT_MAX_REQUESTS=240
- RATE_LIMIT_MAX_KEYS=5000

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
- Stores in-memory room chat message.

### GET /chat/history?roomId=room_123&userId=user_456&limit=60

Behavior:

- User must be authorized for room.
- Returns recent in-memory room messages.

### GET /health

Response:

```json
{
  "totalRooms": 2,
  "totalUsers": 8,
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
