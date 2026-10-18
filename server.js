const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));

const BRIDGE_KEY = process.env.BRIDGE_KEY || "CHANGE_ME_LONG_SECRET";

// ----------------------
// In-memory state
// ----------------------
const sessions = new Map();        // streamId -> session
const serverQueues = new Map();    // serverId -> [commands]
const answers = new Map();         // streamId -> answer
const iceUp = new Map();           // streamId -> [ice from FiveM -> web]
const heartbeats = new Map();      // serverId -> timestamp

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
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => {
  res.send("Lunix WebRTC Signal OK");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    serversOnline: heartbeats.size,
    sessions: sessions.size,
  });
});

// ----------------------
// Website -> Render
// ----------------------

app.get("/api/webrtc/sessions", (req, res) => {
  const serverId = String(req.query.serverId || "");
  let out = Array.from(sessions.values());

  if (serverId) {
    out = out.filter((s) => String(s.serverId) === serverId);
  }

  res.json({
    success: true,
    sessions: out,
  });
});

app.post("/api/webrtc/start-stream", (req, res) => {
  const { serverId, playerId, playerName } = req.body || {};
  if (!serverId || !playerId) {
    return res.status(400).json({ success: false, error: "missing_fields" });
  }

  const streamId = `stream_${playerId}_${Date.now()}`;

  queueForServer(String(serverId), {
    type: "start_stream",
    streamId,
    playerId: String(playerId),
    playerName: playerName || `Player ${playerId}`,
  });

  res.json({
    success: true,
    streamId,
  });
});

app.post("/api/webrtc/offer", (req, res) => {
  const { serverId, playerId, streamId, offer } = req.body || {};
  if (!serverId || !playerId || !streamId || !offer) {
    return res.status(400).json({ success: false, error: "missing_fields" });
  }

  queueForServer(String(serverId), {
    type: "offer",
    streamId: String(streamId),
    playerId: String(playerId),
    offer,
  });

  res.json({ success: true });
});

app.post("/api/webrtc/ice-candidate-remote", (req, res) => {
  const { serverId, playerId, streamId, candidate } = req.body || {};
  if (!serverId || !playerId || !streamId || !candidate) {
    return res.status(400).json({ success: false, error: "missing_fields" });
  }

  queueForServer(String(serverId), {
    type: "remote_ice",
    streamId: String(streamId),
    playerId: String(playerId),
    candidate,
  });

  res.json({ success: true });
});

app.get("/api/webrtc/poll-signals", (req, res) => {
  const streamId = String(req.query.streamId || "");
  if (!streamId) {
    return res.status(400).json({ success: false, error: "missing_streamId" });
  }

  const answer = answers.get(streamId) || null;
  if (answer) {
    answers.delete(streamId);
  }

  const candidates = iceUp.get(streamId) || [];
  iceUp.set(streamId, []);

  res.json({
    success: true,
    answer,
    candidates,
  });
});

// ----------------------
// FiveM -> Render
// ----------------------

app.post("/api/fivem/pull", authBridge, (req, res) => {
  const { serverId } = req.body || {};
  if (!serverId) {
    return res.status(400).json({ success: false, error: "missing_serverId" });
  }

  heartbeats.set(String(serverId), now());

  const queue = serverQueues.get(String(serverId)) || [];
  serverQueues.set(String(serverId), []);

  res.json({
    success: true,
    commands: queue,
  });
});

app.post("/api/fivem/stream-started", authBridge, (req, res) => {
  const { serverId, streamId, playerId, playerName, serverName } = req.body || {};
  if (!serverId || !streamId || !playerId) {
    return res.status(400).json({ success: false, error: "missing_fields" });
  }

  sessions.set(String(streamId), {
    streamId: String(streamId),
    playerId: String(playerId),
    playerName: playerName || `Player ${playerId}`,
    serverId: String(serverId),
    serverName: serverName || "FiveM Server",
    startTime: Date.now(),
    duration: 0,
  });

  res.json({ success: true });
});

app.post("/api/fivem/stream-stopped", authBridge, (req, res) => {
  const { streamId } = req.body || {};
  if (streamId) {
    sessions.delete(String(streamId));
    answers.delete(String(streamId));
    iceUp.delete(String(streamId));
  }

  res.json({ success: true });
});

app.post("/api/fivem/answer", authBridge, (req, res) => {
  const { streamId, answer } = req.body || {};
  if (!streamId || !answer) {
    return res.status(400).json({ success: false, error: "missing_fields" });
  }

  answers.set(String(streamId), answer);
  res.json({ success: true });
});

app.post("/api/fivem/ice-candidate", authBridge, (req, res) => {
  const { streamId, candidate } = req.body || {};
  if (!streamId || !candidate) {
    return res.status(400).json({ success: false, error: "missing_fields" });
  }

  if (!iceUp.has(String(streamId))) {
    iceUp.set(String(streamId), []);
  }
  iceUp.get(String(streamId)).push(candidate);

  res.json({ success: true });
});

app.post("/api/fivem/stream-failed", authBridge, (req, res) => {
  const { streamId } = req.body || {};
  if (streamId) {
    sessions.delete(String(streamId));
  }
  res.json({ success: true });
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
          answers.delete(streamId);
          iceUp.delete(streamId);
        }
      }
    }
  }

  for (const [streamId, session] of sessions.entries()) {
    session.duration = Math.floor((Date.now() - session.startTime) / 1000);
  }
}, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lunix WebRTC Signal running on port ${PORT}`);
});