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

// =============================
// Health routes
// =============================
app.get("/", (_req, res) => {
  res.status(200).send("Lunix WebRTC Signal OK");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    serversConnected: fivemServers.size,
    activeStreams: activeStreams.size
  });
});

// optional debugging
app.get("/sessions", (_req, res) => {
  res.json({
    success: true,
    sessions: Array.from(activeStreams.values()),
    count: activeStreams.size
  });
});

// =============================
// Socket.IO
// =============================
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

// -----------------------------
// Namespace for FiveM bridge
// -----------------------------
const serverApp = io.of("/server-app");

serverApp.on("connection", (socket) => {
  const { licenseKey, version, clientType, serverId, serverName } = socket.handshake.query;

  console.log("[server-app] connected", {
    id: socket.id,
    licenseKey,
    version,
    clientType,
    serverId,
    serverName
  });

  if (clientType !== "WaveShield_Server") {
    console.log("[server-app] invalid client type");
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
    serverId: finalServerId
  });

  // ========== FiveM -> Web ==========
  socket.on("webrtc:answer", (data) => {
    io.emit("webrtc:answer", {
      ...data,
      serverId: finalServerId
    });
  });

  socket.on("webrtc:ice_candidate", (data) => {
    io.emit("webrtc:ice_candidate", {
      ...data,
      serverId: finalServerId
    });
  });

  socket.on("webrtc:stream_started", (data) => {
    const stream = {
      streamId: data.streamId,
      playerId: String(data.playerId),
      playerName: data.playerName || `Player ${data.playerId}`,
      serverId: finalServerId,
      serverName: finalServerName,
      startTime: data.startTime || Date.now()
    };

    activeStreams.set(stream.streamId, stream);

    io.emit("stream:started", stream);
  });

  socket.on("webrtc:stream_stopped", (data) => {
    const streamId = data.streamId;
    if (streamId && activeStreams.has(streamId)) {
      activeStreams.delete(streamId);
    }

    io.emit("stream:stopped", {
      ...data,
      serverId: finalServerId
    });
  });

  socket.on("disconnect", (reason) => {
    console.log("[server-app] disconnected", finalServerId, reason);

    fivemServers.delete(finalServerId);

    for (const [streamId, session] of activeStreams.entries()) {
      if (session.serverId === finalServerId) {
        activeStreams.delete(streamId);
        io.emit("stream:stopped", {
          streamId,
          playerId: session.playerId,
          playerName: session.playerName,
          serverId: finalServerId,
          reason: "server_disconnected"
        });
      }
    }
  });
});

// -----------------------------
// Root namespace for website
// -----------------------------
io.on("connection", (socket) => {
  console.log("[web] connected", socket.id);

  socket.on("webrtc:subscribe", () => {
    console.log("[web] subscribed", socket.id);
  });

  socket.on("webrtc:unsubscribe", () => {
    console.log("[web] unsubscribed", socket.id);
  });

  // Web -> FiveM
  socket.on("webrtc:offer", (data) => {
    const { serverId } = data;
    const serverSocket = fivemServers.get(String(serverId));
    if (!serverSocket) {
      console.log("[web] no FiveM server found for offer", serverId);
      return;
    }

    serverSocket.emit("webrtc:offer", data);
  });

  socket.on("webrtc:ice_candidate_remote", (data) => {
    const { serverId } = data;
    const serverSocket = fivemServers.get(String(serverId));
    if (!serverSocket) {
      console.log("[web] no FiveM server found for remote ICE", serverId);
      return;
    }

    serverSocket.emit("webrtc:ice_candidate_remote", data);
  });

  socket.on("webrtc:start_stream_request", (data) => {
    const { serverId } = data;
    const serverSocket = fivemServers.get(String(serverId));
    if (!serverSocket) {
      console.log("[web] no FiveM server found for start stream", serverId);
      return;
    }

    serverSocket.emit("webrtc:start_stream_request", data);
  });

  socket.on("webrtc:stop_stream", (data) => {
    const { serverId } = data;
    const serverSocket = fivemServers.get(String(serverId));
    if (!serverSocket) {
      console.log("[web] no FiveM server found for stop stream", serverId);
      return;
    }

    serverSocket.emit("webrtc:stop_stream", data);
  });

  socket.on("disconnect", (reason) => {
    console.log("[web] disconnected", socket.id, reason);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Lunix WebRTC Signal running on port ${PORT}`);
});