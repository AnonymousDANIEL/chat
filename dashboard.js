const listEl = document.getElementById("list");
const sessionInput = document.getElementById("sessionId");

function dotClass(status){
    if (status === "ready") return "ready";
    if (status === "qr") return "qr";
    if (status === "deleted") return "deleted";
    return "";
}

function render(sessions){
    listEl.innerHTML = "";
    sessions.forEach(s => {
        const wrap = document.createElement("div");
        wrap.className = "sessionItem";

        const qr = document.createElement("div");
        qr.className = "qrBox";
        if (s.qrDataUrl) {
            const img = document.createElement("img");
            img.src = s.qrDataUrl;
            qr.appendChild(img);
        } else {
            const p = document.createElement("div");
            p.className = "placeholder";
            qr.appendChild(p);
        }

        const right = document.createElement("div");
        right.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="font-weight:900">${s.sessionId}</div>
        <span class="pill"><span class="badgeDot ${dotClass(s.status)}"></span>status: <b>${s.status}</b></span>
        <span class="pill">me: <b>${s.me || "-"}</b></span>
      </div>
      <div class="actions" style="margin-top:10px">
        <button class="secondary" data-open="${s.sessionId}">Open Chats</button>
        <button class="secondary" data-sync="${s.sessionId}">Sync</button>
        <button class="secondary" data-rescan="${s.sessionId}">Rescan</button>
        <button class="danger" data-del="${s.sessionId}">Delete</button>
      </div>
      <div class="small" style="margin-top:8px;color:rgba(234,242,255,.55)">
        说明：Delete 会删除 auth + db，不会再复活
      </div>
    `;

        wrap.appendChild(qr);
        wrap.appendChild(right);
        listEl.appendChild(wrap);
    });
}

async function refresh(){
    const r = await fetch("/api/sessions");
    const j = await r.json();
    const sessions = (j.sessions || []).map(x => ({...x, qrDataUrl:""}));
    // QR 需要再拉一次（避免 sessions 太大）
    for (const s of sessions) {
        const q = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/qr`);
        const qj = await q.json();
        s.status = qj.status || s.status;
        s.me = qj.me || s.me;
        s.qrDataUrl = qj.qrDataUrl || "";
    }
    render(sessions);
}

document.getElementById("create").onclick = async () => {
    const sessionId = sessionInput.value.trim();
    await fetch("/api/sessions", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ sessionId })
    });
    sessionInput.value = "";
    await refresh();
};

document.getElementById("logout").onclick = async () => {
    await fetch("/api/logout", { method:"POST" });
    location.href = "/login.html";
};

listEl.onclick = async (e) => {
    const t = e.target;
    const sid = t.getAttribute("data-open") || t.getAttribute("data-sync") || t.getAttribute("data-rescan") || t.getAttribute("data-del");
    if (!sid) return;

    if (t.getAttribute("data-open")) {
        location.href = `/app.html?sessionId=${encodeURIComponent(sid)}`;
        return;
    }
    if (t.getAttribute("data-sync")) {
        await fetch(`/api/sessions/${encodeURIComponent(sid)}/sync`, { method:"POST" });
        alert("Sync done");
        return;
    }
    if (t.getAttribute("data-rescan")) {
        await fetch(`/api/sessions/${encodeURIComponent(sid)}/rescan`, { method:"POST" });
        await refresh();
        return;
    }
    if (t.getAttribute("data-del")) {
        if (!confirm(`Delete session ${sid}? (will remove auth + db)`)) return;
        await fetch(`/api/sessions/${encodeURIComponent(sid)}`, { method:"DELETE" });
        await refresh();
    }
};

const socket = io();
socket.on("sessions:init", () => refresh());
socket.on("session:update", () => refresh());
socket.on("session:deleted", () => refresh());

refresh();