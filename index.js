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

// ====== 简单账号密码（你可之后改成数据库） ======
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "123456";
const COOKIE_NAME = "wa_admin";

function signToken() {
    // 超简 token（够用）
    return Buffer.from(`${ADMIN_USER}:${Date.now()}`).toString("base64");
}

function authMiddleware(req, res, next) {
    if (req.path.startsWith("/login") || req.path.startsWith("/public") || req.path.startsWith("/socket.io")) return next();
    const t = req.cookies[COOKIE_NAME];
    if (!t) return res.redirect("/login.html");
    return next();
}

// ====== 会话管理 ======
const sessions = new Map();
// sessions.get(sessionId) = { client, status, qrDataUrl, me, lastSeen }

function safeSessionId(input) {
    const s = String(input || "").trim();
    if (!s) return `s_${Math.random().toString(36).slice(2, 10)}`;
    // 只允许字母数字下划线短横
    const cleaned = s.replace(/[^\w-]/g, "");
    return cleaned || `s_${Math.random().toString(36).slice(2, 10)}`;
}

function sessionAuthPath(sessionId) {
    // 每个 session 独立 auth，真正多开
    return path.join(__dirname, ".wwebjs_auth", sessionId);
}

async function ensureSession(sessionId, io) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);

    const authPath = sessionAuthPath(sessionId);
    fs.mkdirSync(authPath, { recursive: true });

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: sessionId,
            dataPath: path.join(__dirname, ".wwebjs_auth"),
        }),
        puppeteer: {
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        },
    });

    const info = {
        sessionId,
        client,
        status: "init",
        qrDataUrl: "",
        me: "",
        lastSeen: Date.now(),
    };
    sessions.set(sessionId, info);

    const emit = (payload) => io.emit("session:update", payload);

    client.on("qr", async (qr) => {
        info.status = "qr";
        info.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 6 });
        emit({ sessionId, status: info.status, qrDataUrl: info.qrDataUrl, me: info.me });
    });

    client.on("ready", async () => {
        info.status = "ready";
        info.qrDataUrl = "";
        try {
            const me = client.info?.wid?._serialized || "";
            info.me = me;
        } catch {}
        emit({ sessionId, status: info.status, qrDataUrl: "", me: info.me });
    });

    client.on("authenticated", () => {
        info.status = "authenticated";
        emit({ sessionId, status: info.status, qrDataUrl: info.qrDataUrl, me: info.me });
    });

    client.on("auth_failure", (m) => {
        info.status = "auth_failure";
        emit({ sessionId, status: info.status, error: String(m || "") });
    });

    client.on("disconnected", (reason) => {
        info.status = "disconnected";
        emit({ sessionId, status: info.status, error: String(reason || "") });
    });

    client.on("message", async (msg) => {
        // 保存消息到 DB + 推送到前端
        try {
            const chatId = msg.from || msg.to;
            const ts = msg.timestamp || Math.floor(Date.now() / 1000);
            insertMessage({
                sessionId,
                chatId,
                msgId: msg.id?._serialized || `${ts}_${Math.random()}`,
                fromMe: msg.fromMe,
                author: msg.author || "",
                body: msg.body || "",
                timestamp: ts,
            });

            // 更新 chat 列表
            try {
                const chat = await msg.getChat();
                const name = chat.name || chat.formattedTitle || chatId;
                const kind = chat.isGroup ? "group" : "dm";
                upsertChat({
                    sessionId,
                    chatId,
                    name,
                    lastMessage: (msg.body || "").slice(0, 100),
                    lastTimestamp: ts,
                    unreadCount: chat.unreadCount || 0,
                    kind,
                    avatarUrl: "", // 先留空（避免慢），聊天页需要可后续再做拉取
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
            // ignore
        }
    });

    client.initialize();
    return info;
}

async function deleteSession(sessionId, io) {
    const info = sessions.get(sessionId);
    if (info) {
        try { await info.client.destroy(); } catch {}
        sessions.delete(sessionId);
    }

    // 删除 DB
    deleteSessionData(sessionId);

    // 删除 auth/cache（关键：防止复活）
    const authDir = path.join(__dirname, ".wwebjs_auth", sessionId);
    const cacheDir = path.join(__dirname, ".wwebjs_cache", sessionId);

    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}

    io.emit("session:deleted", { sessionId });
}

// ====== App / Socket ======
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, "public")));
app.use(authMiddleware);

// Login
app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    if (String(username) === ADMIN_USER && String(password) === ADMIN_PASS) {
        res.cookie(COOKIE_NAME, signToken(), { httpOnly: true, sameSite: "lax" });
        return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false, error: "Bad credentials" });
});

app.post("/api/logout", (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
});

// Sessions
app.get("/api/sessions", (req, res) => {
    const list = Array.from(sessions.values()).map(s => ({
        sessionId: s.sessionId,
        status: s.status,
        me: s.me,
        hasQr: !!s.qrDataUrl,
    }));
    res.json({ ok: true, sessions: list });
});

app.post("/api/sessions", async (req, res) => {
    const raw = req.body?.sessionId;
    const sessionId = safeSessionId(raw);
    await ensureSession(sessionId, io);
    res.json({ ok: true, sessionId });
});

app.post("/api/sessions/:sessionId/rescan", async (req, res) => {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);
    if (!info) return res.status(404).json({ ok: false, error: "No session" });

    try {
        await info.client.destroy();
    } catch {}
    sessions.delete(sessionId);
    await ensureSession(sessionId, io);

    res.json({ ok: true });
});

app.delete("/api/sessions/:sessionId", async (req, res) => {
    const sessionId = safeSessionId(req.params.sessionId);
    await deleteSession(sessionId, io);
    res.json({ ok: true });
});

app.get("/api/sessions/:sessionId/qr", (req, res) => {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);
    if (!info) return res.status(404).json({ ok: false, error: "No session" });
    res.json({ ok: true, status: info.status, me: info.me, qrDataUrl: info.qrDataUrl || "" });
});

// Chats / Messages
app.get("/api/sessions/:sessionId/chats", async (req, res) => {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);
    if (!info) return res.status(404).json({ ok: false, error: "No session" });

    // 返回 DB chats（更快更稳）
    const chats = listChats(sessionId);
    res.json({ ok: true, status: info.status, me: info.me, chats });
});

app.post("/api/sessions/:sessionId/sync", async (req, res) => {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);
    if (!info) return res.status(404).json({ ok: false, error: "No session" });
    if (info.status !== "ready") return res.status(400).json({ ok: false, error: "Not ready" });

    // 从 WA 拉 chats 存 DB（按需）
    try {
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
        return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

app.get("/api/sessions/:sessionId/chats/:chatId/messages", (req, res) => {
    const sessionId = safeSessionId(req.params.sessionId);
    const chatId = decodeURIComponent(req.params.chatId);
    const msgs = listMessages(sessionId, chatId, 120);
    res.json({ ok: true, messages: msgs });
});

app.post("/api/sessions/:sessionId/send", async (req, res) => {
    const sessionId = safeSessionId(req.params.sessionId);
    const info = sessions.get(sessionId);
    if (!info) return res.status(404).json({ ok: false, error: "No session" });
    if (info.status !== "ready") return res.status(400).json({ ok: false, error: "Not ready" });

    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok: false, error: "Missing to/text" });

    try {
        await info.client.sendMessage(String(to), String(text));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

io.on("connection", (socket) => {
    // 连接后发当前 sessions
    const list = Array.from(sessions.values()).map(s => ({
        sessionId: s.sessionId,
        status: s.status,
        me: s.me,
        qrDataUrl: s.qrDataUrl || "",
    }));
    socket.emit("sessions:init", { sessions: list });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});