const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));

const httpServer = createServer(app);

const BRIDGE_KEY = process.env.BRIDGE_KEY || "CHANGE_ME_LONG_SECRET";
const WEB_DASHBOARD_KEY = process.env.WEB_DASHBOARD_KEY || "CHANGE_ME_WEB_KEY";

const sessions = new Map();      // streamId -> { streamId, playerId, playerName, serverId, serverName, startTime, duration }
const serverQueues = new Map();  // serverId -> [commands]
const heartbeats = new Map();    // serverId -> timestamp

function now() {
  return Date.now();
}

function queueForServer(serverId, command) {
  if (!serverQueues.has(serverId)) {
    serverQueues.set(serverId, []);
  }
  serverQueues.get(serverId).push(command);
}

function authBridge(req, res, next) {
  const key = req.headers["x-bridge-key"];
  if (key !== BRIDGE_KEY) {
    return res.status(401).json({ success: false, error: "unauthorized_bridge" });
  }
  next();
}

function authWeb(req, res, next) {
  // إذا لا تريد auth إضافي من الويب، تقدر تشيله
  // لكن نتركه اختياري:
  const key = req.headers["x-dashboard-key"];
  if (WEB_DASHBOARD_KEY && key && key !== WEB_DASHBOARD_KEY) {
    return res.status(401).json({ success: false, error: "unauthorized_web" });
  }
  next();
}

app.get("/", (_req, res) => {
  res.status(200).send("Lunix LiveView Signal OK");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    serversOnline: heartbeats.size,
    sessions: sessions.size
  });
});

// -----------------------------
// Web API
// -----------------------------

app.get("/api/liveview/sessions", authWeb, (req, res) => {
  const serverId = String(req.query.serverId || "");
  let out = Array.from(sessions.values());

  if (serverId) {
    out = out.filter((s) => String(s.serverId) === serverId);
  }

  res.json({
    success: true,
    sessions: out
  });
});

app.post("/api/liveview/start-stream", authWeb, (req, res) => {
  const { serverId, playerId, playerName } = req.body || {};

  if (!serverId || !playerId) {
    return res.status(400).json({
      success: false,
      error: "missing_fields"
    });
  }

  const streamId = `stream_${String(playerId)}_${Date.now()}`;

  queueForServer(String(serverId), {
    type: "start_stream",
    streamId,
    playerId: String(playerId),
    playerName: playerName || `Player ${playerId}`
  });

  return res.json({
    success: true,
    streamId
  });
});

app.post("/api/liveview/stop-stream", authWeb, (req, res) => {
  const { serverId, playerId, streamId } = req.body || {};

  if (!serverId || !playerId) {
    return res.status(400).json({
      success: false,
      error: "missing_fields"
    });
  }

  queueForServer(String(serverId), {
    type: "stop_stream",
    streamId: streamId || null,
    playerId: String(playerId)
  });

  return res.json({
    success: true
  });
});

app.post("/api/liveview/offer", authWeb, (req, res) => {
  const { serverId, playerId, streamId, offer } = req.body || {};

  if (!serverId || !playerId || !streamId || !offer) {
    return res.status(400).json({
      success: false,
      error: "missing_fields"
    });
  }

  queueForServer(String(serverId), {
    type: "offer",
    streamId: String(streamId),
    playerId: String(playerId),
    offer
  });

  return res.json({ success: true });
});

app.post("/api/liveview/ice-candidate-remote", authWeb, (req, res) => {
  const { serverId, playerId, streamId, candidate } = req.body || {};

  if (!serverId || !playerId || !streamId || !candidate) {
    return res.status(400).json({
      success: false,
      error: "missing_fields"
    });
  }

  queueForServer(String(serverId), {
    type: "remote_ice",
    streamId: String(streamId),
    playerId: String(playerId),
    candidate
  });

  return res.json({ success: true });
});

// -----------------------------
// FiveM Bridge API
// -----------------------------

app.post("/api/fivem/liveview/pull", authBridge, (req, res) => {
  const { serverId } = req.body || {};

  if (!serverId) {
    return res.status(400).json({
      success: false,
      error: "missing_serverId"
    });
  }

  heartbeats.set(String(serverId), now());

  const queue = serverQueues.get(String(serverId)) || [];
  serverQueues.set(String(serverId), []);

  return res.json({
    success: true,
    commands: queue
  });
});

app.post("/api/fivem/liveview/stream-started", authBridge, (req, res) => {
  const { streamId, playerId, playerName, serverId, serverName } = req.body || {};

  if (!streamId || !playerId || !serverId) {
    return res.status(400).json({
      success: false,
      error: "missing_fields"
    });
  }

  sessions.set(String(streamId), {
    streamId: String(streamId),
    playerId: String(playerId),
    playerName: playerName || `Player ${playerId}`,
    serverId: String(serverId),
    serverName: serverName || "FiveM Server",
    startTime: Date.now(),
    duration: 0
  });

  io.emit("liveview:stream_started", sessions.get(String(streamId)));

  return res.json({ success: true });
});

app.post("/api/fivem/liveview/stream-stopped", authBridge, (req, res) => {
  const { streamId, reason, serverId } = req.body || {};

  if (streamId) {
    const existing = sessions.get(String(streamId));
    sessions.delete(String(streamId));

    io.emit("liveview:stream_stopped", {
      streamId: String(streamId),
      reason: reason || "stopped",
      serverId: serverId || existing?.serverId || null,
      playerId: existing?.playerId || null,
      playerName: existing?.playerName || null
    });
  }

  return res.json({ success: true });
});

app.post("/api/fivem/liveview/answer", authBridge, (req, res) => {
  const { streamId, answer, serverId, playerId } = req.body || {};

  if (!streamId || !answer) {
    return res.status(400).json({
      success: false,
      error: "missing_fields"
    });
  }

  io.emit("liveview:answer", {
    streamId: String(streamId),
    answer,
    serverId: String(serverId || ""),
    playerId: String(playerId || "")
  });

  return res.json({ success: true });
});

app.post("/api/fivem/liveview/ice-candidate", authBridge, (req, res) => {
  const { streamId, candidate, serverId, playerId } = req.body || {};

  if (!streamId || !candidate) {
    return res.status(400).json({
      success: false,
      error: "missing_fields"
    });
  }

  io.emit("liveview:ice_candidate", {
    streamId: String(streamId),
    candidate,
    serverId: String(serverId || ""),
    playerId: String(playerId || "")
  });

  return res.json({ success: true });
});

app.post("/api/fivem/liveview/stream-failed", authBridge, (req, res) => {
  const { streamId, reason, serverId } = req.body || {};

  if (streamId) {
    const existing = sessions.get(String(streamId));
    sessions.delete(String(streamId));

    io.emit("liveview:stream_stopped", {
      streamId: String(streamId),
      reason: reason || "failed",
      serverId: serverId || existing?.serverId || null,
      playerId: existing?.playerId || null,
      playerName: existing?.playerName || null
    });
  }

  return res.json({ success: true });
});

// -----------------------------
// Socket for Website
// -----------------------------
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

io.on("connection", (socket) => {
  console.log("[liveview-web] connected", socket.id);

  socket.on("liveview:subscribe", () => {
    console.log("[liveview-web] subscribed", socket.id);
  });

  socket.on("liveview:unsubscribe", () => {
    console.log("[liveview-web] unsubscribed", socket.id);
  });

  socket.on("disconnect", (reason) => {
    console.log("[liveview-web] disconnected", socket.id, reason);
  });
});

// stale cleanup
setInterval(() => {
  const t = now();

  for (const [serverId, ts] of heartbeats.entries()) {
    if (t - ts > 30000) {
      heartbeats.delete(serverId);

      for (const [streamId, session] of sessions.entries()) {
        if (String(session.serverId) === String(serverId)) {
          sessions.delete(streamId);
          io.emit("liveview:stream_stopped", {
            streamId,
            reason: "server_timeout",
            serverId: session.serverId,
            playerId: session.playerId,
            playerName: session.playerName
          });
        }
      }
    }
  }

  for (const [streamId, session] of sessions.entries()) {
    session.duration = Math.floor((Date.now() - session.startTime) / 1000);
  }
}, 5000);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Lunix LiveView Signal running on port ${PORT}`);
});