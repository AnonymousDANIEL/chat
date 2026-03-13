const express = require("express");
const path = require("path");
const fs = require("fs");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const http = require("http");
const { Server } = require("socket.io");

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

const {
  upsertChat,
  insertMessage,
  listChats,
  listMessages,
  deleteSessionData,
} = require("./db");

const PORT = process.env.PORT || 3001;

// ====== 简单账号密码（可改成 Railway Variables）======
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "123456";
const COOKIE_NAME = "wa_admin";

// ====== 工具函数 ======
function signToken() {
  return Buffer.from(`${ADMIN_USER}:${Date.now()}`).toString("base64");
}

function safeSessionId(input) {
  const s = String(input || "").trim();
  if (!s) return `s_${Math.random().toString(36).slice(2, 10)}`;
  const cleaned = s.replace(/[^\w-]/g, "");
  return cleaned || `s_${Math.random().toString(36).slice(2, 10)}`;
}

function getBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ====== auth middleware ======
function authMiddleware(req, res, next) {
  const openPaths = [
    "/login.html",
    "/api/login",
    "/socket.io",
    "/health",
  ];

  const isOpen =
    openPaths.some((p) => req.path === p || req.path.startsWith(`${p}/`)) ||
    req.path.startsWith("/public/");

  if (isOpen) return next();

  const t = req.cookies[COOKIE_NAME];
  if (!t) return res.redirect("/login.html");

  return next();
}

// ====== Session 管理 ======
const sessions = new Map();
/*
sessions.get(sessionId) = {
  sessionId,
  client,
  status,
  qrDataUrl,
  me,
  lastSeen
}
*/

function authBasePath() {
  const dir = path.join(__dirname, ".wwebjs_auth");
  ensureDir(dir);
  return dir;
}

function cacheBasePath() {
  const dir = path.join(__dirname, ".wwebjs_cache");
  ensureDir(dir);
  return dir;
}

async function ensureSession(sessionId, io) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  authBasePath();
  cacheBasePath();

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: authBasePath(),
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  const info = {
    sessionId,
    client,
    status: "initializing",
    qrDataUrl: "",
    me: "",
    lastSeen: Date.now(),
  };

  sessions.set(sessionId, info);

  const emitUpdate = (extra = {}) => {
    io.emit("session:update", {
      sessionId: info.sessionId,
      status: info.status,
      qrDataUrl: info.qrDataUrl,
      me: info.me,
      lastSeen: info.lastSeen,
      ...extra,
    });
  };

  client.on("qr", async (qr) => {
    try {
      info.status = "qr";
      info.lastSeen = Date.now();
      info.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 6 });
      emitUpdate();
      console.log(`[${sessionId}] QR generated`);
    } catch (e) {
      console.error(`[${sessionId}] QR generate error:`, e.message);
    }
  });

  client.on("authenticated", () => {
    info.status = "authenticated";
    info.lastSeen = Date.now();
    emitUpdate();
    console.log(`[${sessionId}] authenticated`);
  });

  client.on("ready", async () => {
    try {
      info.status = "ready";
      info.lastSeen = Date.now();
      info.qrDataUrl = "";

      try {
        info.me = client.info?.wid?._serialized || "";
      } catch {
        info.me = "";
      }

      emitUpdate();
      console.log(`[${sessionId}] ready`);
    } catch (e) {
      console.error(`[${sessionId}] ready handler error:`, e.message);
    }
  });

  client.on("auth_failure", (msg) => {
    info.status = "auth_failure";
    info.lastSeen = Date.now();
    emitUpdate({ error: String(msg || "") });
    console.error(`[${sessionId}] auth_failure:`, msg);
  });

  client.on("disconnected", (reason) => {
    info.status = "disconnected";
    info.lastSeen = Date.now();
    emitUpdate({ error: String(reason || "") });
    console.warn(`[${sessionId}] disconnected:`, reason);
  });

  client.on("message", async (msg) => {
    try {
      const chatId = msg.from || msg.to || "";
      const ts = msg.timestamp || Math.floor(Date.now() / 1000);

      insertMessage({
        sessionId,
        chatId,
        msgId: msg.id?._serialized || `${ts}_${Math.random().toString(36).slice(2, 8)}`,
        fromMe: !!msg.fromMe,
        author: msg.author || "",
        body: msg.body || "",
        timestamp: ts,
      });

      try {
        const chat = await msg.getChat();
        const name = chat.name || chat.formattedTitle || chatId;
        const kind = chat.isGroup ? "group" : "dm";

        upsertChat({
          sessionId,
          chatId,
          name,
          lastMessage: String(msg.body || "").slice(0, 100),
          lastTimestamp: ts,
          unreadCount: chat.unreadCount || 0,
          kind,
          avatarUrl: "",
        });
      } catch {}

      io.emit("message:new", {
        sessionId,
        chatId,
        fromMe: !!msg.fromMe,
        body: msg.body || "",
        timestamp: ts,
      });
    } catch (e) {
      console.error(`[${sessionId}] message handler error:`, e.message);
    }
  });

  try {
    await client.initialize();
  } catch (e) {
    info.status = "init_error";
    emitUpdate({ error: String(e?.message || e) });
    console.error(`[${sessionId}] initialize error:`, e.message);
  }

  return info;
}

async function destroySessionOnly(sessionId) {
  const info = sessions.get(sessionId);
  if (!info) return;

  try {
    await info.client.destroy();
  } catch {}

  sessions.delete(sessionId);
}

async function deleteSession(sessionId, io) {
  await destroySessionOnly(sessionId);

  try {
    deleteSessionData(sessionId);
  } catch (e) {
    console.error(`[${sessionId}] delete DB data error:`, e.message);
  }

  const authDir = path.join(authBasePath(), `session-${sessionId}`);
  const cacheDir = path.join(cacheBasePath(), sessionId);

  try {
    fs.rmSync(authDir, { recursive: true, force: true });
  } catch {}

  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } catch {}

  io.emit("session:deleted", { sessionId });
  console.log(`[${sessionId}] deleted`);
}

// ====== Express / Socket ======
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 静态文件
app.use(express.static(path.join(__dirname, "public")));
app.use(authMiddleware);

// ====== Health check ======
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "wa-web",
    uptime: process.uptime(),
    now: Date.now(),
  });
});

// ====== Login ======
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};

  if (String(username) === ADMIN_USER && String(password) === ADMIN_PASS) {
    res.cookie(COOKIE_NAME, signToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return res.json({ ok: true });
  }

  return res.status(401).json({
    ok: false,
    error: "Bad credentials",
  });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ====== Session APIs ======
app.get("/api/sessions", (req, res) => {
  const list = Array.from(sessions.values()).map((s) => ({
    sessionId: s.sessionId,
    status: s.status,
    me: s.me,
    hasQr: !!s.qrDataUrl,
    qrDataUrl: s.qrDataUrl || "",
    lastSeen: s.lastSeen,
  }));

  res.json({ ok: true, sessions: list });
});

app.post("/api/sessions", async (req, res) => {
  try {
    const raw = req.body?.sessionId;
    const sessionId = safeSessionId(raw);

    await ensureSession(sessionId, io);

    res.json({
      ok: true,
      sessionId,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

app.post("/api/sessions/:sessionId/rescan", async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);

    if (!info) {
      return res.status(404).json({
        ok: false,
        error: "No session",
      });
    }

    try {
      await info.client.destroy();
    } catch {}

    sessions.delete(sessionId);
    await ensureSession(sessionId, io);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

app.delete("/api/sessions/:sessionId", async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    await deleteSession(sessionId, io);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

app.get("/api/sessions/:sessionId/qr", (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);
  const info = sessions.get(sessionId);

  if (!info) {
    return res.status(404).json({
      ok: false,
      error: "No session",
    });
  }

  res.json({
    ok: true,
    status: info.status,
    me: info.me,
    qrDataUrl: info.qrDataUrl || "",
  });
});

// ====== Chats / Messages ======
app.get("/api/sessions/:sessionId/chats", (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);

    if (!info) {
      return res.status(404).json({
        ok: false,
        error: "No session",
      });
    }

    const chats = listChats(sessionId);

    return res.json({
      ok: true,
      status: info.status,
      me: info.me,
      chats,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

app.post("/api/sessions/:sessionId/sync", async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);

    if (!info) {
      return res.status(404).json({
        ok: false,
        error: "No session",
      });
    }

    if (info.status !== "ready") {
      return res.status(400).json({
        ok: false,
        error: "Not ready",
      });
    }

    const waChats = await info.client.getChats();

    for (const c of waChats.slice(0, 300)) {
      const chatId = c.id?._serialized || "";
      const name = c.name || c.formattedTitle || chatId;
      const kind = c.isGroup ? "group" : "dm";
      const lastMsg = c.lastMessage?.body || "";
      const ts = c.lastMessage?.timestamp || 0;

      upsertChat({
        sessionId,
        chatId,
        name,
        lastMessage: String(lastMsg).slice(0, 100),
        lastTimestamp: ts,
        unreadCount: c.unreadCount || 0,
        kind,
        avatarUrl: "",
      });
    }

    io.emit("chats:updated", { sessionId });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

app.get("/api/sessions/:sessionId/chats/:chatId/messages", (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const chatId = decodeURIComponent(req.params.chatId);

    const msgs = listMessages(sessionId, chatId, 120);

    return res.json({
      ok: true,
      messages: msgs,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

app.post("/api/sessions/:sessionId/send", async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);

    if (!info) {
      return res.status(404).json({
        ok: false,
        error: "No session",
      });
    }

    if (info.status !== "ready") {
      return res.status(400).json({
        ok: false,
        error: "Not ready",
      });
    }

    const { to, text } = req.body || {};

    if (!to || !text) {
      return res.status(400).json({
        ok: false,
        error: "Missing to/text",
      });
    }

    await info.client.sendMessage(String(to), String(text));

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// ====== Socket ======
io.on("connection", (socket) => {
  const list = Array.from(sessions.values()).map((s) => ({
    sessionId: s.sessionId,
    status: s.status,
    me: s.me,
    qrDataUrl: s.qrDataUrl || "",
    lastSeen: s.lastSeen,
  }));

  socket.emit("sessions:init", { sessions: list });
});

// ====== 404 fallback ======
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
    path: req.path,
  });
});

// ====== Start ======
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
