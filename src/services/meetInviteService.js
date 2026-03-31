const userNotifications = new Map();
const { sendMeetInvitePush } = require("./pushService");

function getBucket(userId) {
  if (!userNotifications.has(userId)) {
    userNotifications.set(userId, []);
  }
  return userNotifications.get(userId);
}

function enqueueMeetInvite({ roomId, fromUserId, toUserId }) {
  const bucket = getBucket(toUserId);
  const payload = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "meet_invite",
    roomId,
    fromUserId,
    toUserId,
    message: `${fromUserId} started Meet in room ${roomId}`,
    createdAt: Date.now(),
  };

  bucket.push(payload);
  if (bucket.length > 100) {
    bucket.splice(0, bucket.length - 100);
  }

  // Fire-and-forget push delivery; in-app polling notifications remain primary source.
  sendMeetInvitePush({ toUserId }).catch(() => {});

  return payload;
}

function pullUserNotifications(userId) {
  const bucket = userNotifications.get(userId) || [];
  userNotifications.set(userId, []);
  return bucket;
}

module.exports = {
  enqueueMeetInvite,
  pullUserNotifications,
};
