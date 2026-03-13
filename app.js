const qs = new URLSearchParams(location.search);
let currentSession = qs.get("sessionId") || "";
let currentChatId = "";
let filter = "all";

const sessionSel = document.getElementById("sessionSel");
const statusPill = document.getElementById("statusPill");
const chatList = document.getElementById("chatList");
const msgs = document.getElementById("msgs");
const chatTitle = document.getElementById("chatTitle");
const qInput = document.getElementById("q");
const toInput = document.getElementById("to");
const textInput = document.getElementById("text");
const sub = document.getElementById("sub");

document.getElementById("back").onclick = () => location.href = "/dashboard.html";
document.getElementById("sync").onclick = async () => {
    await fetch(`/api/sessions/${encodeURIComponent(currentSession)}/sync`, { method:"POST" });
    await loadChats();
};

document.querySelectorAll("button[data-filter]").forEach(b => {
    b.onclick = () => { filter = b.getAttribute("data-filter"); loadChats(); };
});

qInput.oninput = () => loadChats();

async function loadSessions(){
    const r = await fetch("/api/sessions");
    const j = await r.json();
    sessionSel.innerHTML = "";
    (j.sessions||[]).forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.sessionId;
        opt.textContent = `${s.sessionId} (${s.status})`;
        sessionSel.appendChild(opt);
    });
    if (!currentSession && (j.sessions||[])[0]) currentSession = j.sessions[0].sessionId;
    sessionSel.value = currentSession;
    sessionSel.onchange = () => {
        currentSession = sessionSel.value;
        currentChatId = "";
        chatTitle.textContent = "未选择聊天";
        msgs.innerHTML = "";
        loadChats();
    };
}

function avatarLetter(name){
    const t = (name||"").trim();
    return (t[0]||"W").toUpperCase();
}

function renderChats(chats){
    chatList.innerHTML = "";
    chats.forEach(c => {
        const row = document.createElement("div");
        row.className = "chatRow";
        row.onclick = () => openChat(c.chatId, c.name || c.chatId);

        const av = document.createElement("div");
        av.className = "avatar";
        av.textContent = avatarLetter(c.name);

        const meta = document.createElement("div");
        meta.className = "chatMeta";

        const nm = document.createElement("div");
        nm.className = "chatName";
        nm.textContent = c.name || c.chatId;

        const last = document.createElement("div");
        last.className = "chatLast";
        last.textContent = c.lastMessage || "";

        meta.appendChild(nm);
        meta.appendChild(last);

        const tm = document.createElement("div");
        tm.className = "chatTime";
        tm.textContent = c.lastTimestamp ? new Date(c.lastTimestamp*1000).toLocaleTimeString() : "";

        row.appendChild(av);
        row.appendChild(meta);
        row.appendChild(tm);
        chatList.appendChild(row);
    });
}

async function loadChats(){
    if (!currentSession) return;
    const r = await fetch(`/api/sessions/${encodeURIComponent(currentSession)}/chats`);
    const j = await r.json();
    statusPill.innerHTML = `status: <b>${j.status || "-"}</b>`;
    sub.textContent = `session: ${currentSession} | me: ${j.me || "-"}`;

    let chats = j.chats || [];
    const kw = qInput.value.trim().toLowerCase();
    if (filter !== "all") chats = chats.filter(x => (x.kind || "dm") === filter);
    if (kw) chats = chats.filter(x =>
        String(x.name||"").toLowerCase().includes(kw) ||
        String(x.chatId||"").toLowerCase().includes(kw) ||
        String(x.lastMessage||"").toLowerCase().includes(kw)
    );
    renderChats(chats);
}

async function openChat(chatId, name){
    currentChatId = chatId;
    chatTitle.textContent = name;
    toInput.value = chatId;
    await loadMessages();
}

async function loadMessages(){
    if (!currentSession || !currentChatId) return;
    const r = await fetch(`/api/sessions/${encodeURIComponent(currentSession)}/chats/${encodeURIComponent(currentChatId)}/messages`);
    const j = await r.json();
    msgs.innerHTML = "";
    (j.messages||[]).forEach(m => {
        const div = document.createElement("div");
        div.className = "msg " + (m.fromMe ? "me" : "");
        div.innerHTML = `<div>${(m.body||"").replace(/</g,"&lt;")}</div><div class="t">${new Date((m.timestamp||0)*1000).toLocaleString()}</div>`;
        msgs.appendChild(div);
    });
    msgs.scrollTop = msgs.scrollHeight;
}

document.getElementById("send").onclick = async () => {
    const to = toInput.value.trim();
    const text = textInput.value.trim();
    if (!to || !text) return alert("Missing to/text");
    const r = await fetch(`/api/sessions/${encodeURIComponent(currentSession)}/send`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ to, text })
    });
    if (!r.ok) {
        const j = await r.json().catch(()=>({}));
        return alert("Send failed: " + (j.error||r.status));
    }
    textInput.value = "";
};

const socket = io();
socket.on("message:new", (m) => {
    if (m.sessionId === currentSession && m.chatId === currentChatId) {
        // 直接追加，实时推送
        const div = document.createElement("div");
        div.className = "msg " + (m.fromMe ? "me" : "");
        div.innerHTML = `<div>${(m.body||"").replace(/</g,"&lt;")}</div><div class="t">${new Date((m.timestamp||0)*1000).toLocaleString()}</div>`;
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
    }
});
socket.on("chats:updated", (x) => {
    if (x.sessionId === currentSession) loadChats();
});

(async function init(){
    await loadSessions();
    await loadChats();
})();