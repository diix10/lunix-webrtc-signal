const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

const httpServer = createServer(app);

// =============================
// Memory state
// =============================
const activeStreams = new Map();
// streamId -> { streamId, playerId, playerName, serverId, serverName, startTime }

const fivemServers = new Map();
// serverId -> socket

function log(...args) {
  console.log("[Lunix RTC]", ...args);
}

// =============================
// HTTP routes
// =============================
app.get("/", (_req, res) => {
  res.status(200).send("Lunix WebRTC Signal OK");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    serversConnected: fivemServers.size,
    activeStreams: activeStreams.size,
  });
});

app.get("/api/webrtc/sessions", (req, res) => {
  const serverId = String(req.query.serverId || "");
  let sessions = Array.from(activeStreams.values());

  if (serverId) {
    sessions = sessions.filter((s) => String(s.serverId) === serverId);
  }

  res.json({
    success: true,
    sessions,
    count: sessions.length,
  });
});

app.post("/api/webrtc/start-stream", (req, res) => {
  const { serverId, playerId, streamId } = req.body || {};

  if (!serverId || !playerId) {
    return res.status(400).json({
      success: false,
      error: "Missing serverId or playerId",
    });
  }

  const serverSocket = fivemServers.get(String(serverId));
  if (!serverSocket) {
    return res.status(404).json({
      success: false,
      error: "FiveM server not connected",
    });
  }

  const finalStreamId =
    streamId || `stream_${String(playerId)}_${Date.now()}`;

  log("HTTP start-stream -> FiveM", { serverId, playerId, streamId: finalStreamId });

  serverSocket.emit("webrtc:start_stream_request", {
    serverId: String(serverId),
    playerId: String(playerId),
    streamId: finalStreamId,
    iceServers: [],
  });

  return res.json({
    success: true,
    streamId: finalStreamId,
    message: "Stream start request sent",
  });
});

app.post("/api/webrtc/offer", (req, res) => {
  const { serverId, playerId, streamId, offer } = req.body || {};

  if (!serverId || !playerId || !streamId || !offer) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields",
    });
  }

  const serverSocket = fivemServers.get(String(serverId));
  if (!serverSocket) {
    return res.status(404).json({
      success: false,
      error: "FiveM server not connected",
    });
  }

  log("HTTP offer -> FiveM", { serverId, playerId, streamId });

  serverSocket.emit("webrtc:offer", {
    serverId: String(serverId),
    playerId: String(playerId),
    streamId: String(streamId),
    offer,
  });

  return res.json({
    success: true,
    message: "Offer forwarded to FiveM server",
  });
});

app.post("/api/webrtc/ice-candidate-remote", (req, res) => {
  const { serverId, playerId, streamId, candidate } = req.body || {};

  if (!serverId || !playerId || !streamId || !candidate) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields",
    });
  }

  const serverSocket = fivemServers.get(String(serverId));
  if (!serverSocket) {
    return res.status(404).json({
      success: false,
      error: "FiveM server not connected",
    });
  }

  serverSocket.emit("webrtc:ice_candidate_remote", {
    serverId: String(serverId),
    playerId: String(playerId),
    streamId: String(streamId),
    candidate,
  });

  return res.json({
    success: true,
    message: "ICE candidate forwarded to FiveM server",
  });
});

// =============================
// Socket.IO
// =============================
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

// -----------------------------
// Namespace for FiveM bridge
// -----------------------------
const serverApp = io.of("/server-app");

serverApp.on("connection", (socket) => {
  const { licenseKey, version, clientType, serverId, serverName } =
    socket.handshake.query || {};

  log("server-app connected", {
    socketId: socket.id,
    clientType,
    serverId,
    serverName,
    version,
  });

  if (clientType !== "WaveShield_Server") {
    log("invalid clientType, disconnecting");
    socket.disconnect(true);
    return;
  }

  const finalServerId = String(serverId || socket.id);
  const finalServerName = String(serverName || "FiveM Server");

  socket.data.serverId = finalServerId;
  socket.data.serverName = finalServerName;

  fivemServers.set(finalServerId, socket);

  socket.emit("authenticated", {
    success: true,
    serverId: finalServerId,
  });

  // FiveM -> website
  socket.on("webrtc:answer", (data) => {
    log("answer from FiveM", data?.streamId);
    io.emit("webrtc:answer", {
      ...data,
      serverId: finalServerId,
    });
  });

  socket.on("webrtc:ice_candidate", (data) => {
    io.emit("webrtc:ice_candidate", {
      ...data,
      serverId: finalServerId,
    });
  });

  socket.on("webrtc:stream_started", (data) => {
    const stream = {
      streamId: data.streamId,
      playerId: String(data.playerId),
      playerName: data.playerName || `Player ${data.playerId}`,
      serverId: finalServerId,
      serverName: finalServerName,
      startTime: data.startTime || Date.now(),
    };

    activeStreams.set(stream.streamId, stream);
    log("stream_started from FiveM", stream);
    io.emit("stream:started", stream);
  });

  socket.on("webrtc:stream_stopped", (data) => {
    const streamId = data.streamId;
    if (streamId && activeStreams.has(streamId)) {
      activeStreams.delete(streamId);
    }

    log("stream_stopped from FiveM", data);

    io.emit("stream:stopped", {
      ...data,
      serverId: finalServerId,
    });
  });

  socket.on("disconnect", (reason) => {
    log("server-app disconnected", finalServerId, reason);

    fivemServers.delete(finalServerId);

    for (const [streamId, session] of activeStreams.entries()) {
      if (session.serverId === finalServerId) {
        activeStreams.delete(streamId);
        io.emit("stream:stopped", {
          streamId,
          playerId: session.playerId,
          playerName: session.playerName,
          serverId: finalServerId,
          reason: "server_disconnected",
        });
      }
    }
  });
});

// -----------------------------
// Root namespace for website
// -----------------------------
io.on("connection", (socket) => {
  log("web connected", socket.id);

  socket.on("webrtc:subscribe", () => {
    log("web subscribed", socket.id);
  });

  socket.on("webrtc:unsubscribe", () => {
    log("web unsubscribed", socket.id);
  });

  // optional direct socket path from website if you use it later
  socket.on("webrtc:offer", (data) => {
    const serverSocket = fivemServers.get(String(data.serverId));
    if (!serverSocket) return;
    serverSocket.emit("webrtc:offer", data);
  });

  socket.on("webrtc:ice_candidate_remote", (data) => {
    const serverSocket = fivemServers.get(String(data.serverId));
    if (!serverSocket) return;
    serverSocket.emit("webrtc:ice_candidate_remote", data);
  });

  socket.on("webrtc:start_stream_request", (data) => {
    const serverSocket = fivemServers.get(String(data.serverId));
    if (!serverSocket) return;
    serverSocket.emit("webrtc:start_stream_request", data);
  });

  socket.on("webrtc:stop_stream", (data) => {
    const serverSocket = fivemServers.get(String(data.serverId));
    if (!serverSocket) return;
    serverSocket.emit("webrtc:stop_stream", data);
  });

  socket.on("disconnect", (reason) => {
    log("web disconnected", socket.id, reason);
  });
});

// =============================
// Boot
// =============================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  log(`Lunix WebRTC Signal running on port ${PORT}`);
});