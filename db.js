const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT NOT NULL,
  chatId TEXT NOT NULL,
  msgId TEXT NOT NULL,
  fromMe INTEGER NOT NULL,
  author TEXT,
  body TEXT,
  timestamp INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique
ON messages(sessionId, chatId, msgId);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT NOT NULL,
  chatId TEXT NOT NULL,
  name TEXT,
  lastMessage TEXT,
  lastTimestamp INTEGER,
  unreadCount INTEGER DEFAULT 0,
  kind TEXT DEFAULT 'dm',
  avatarUrl TEXT,
  UNIQUE(sessionId, chatId)
);
`);

function upsertChat({ sessionId, chatId, name, lastMessage, lastTimestamp, unreadCount, kind, avatarUrl }) {
    const stmt = db.prepare(`
    INSERT INTO chats(sessionId, chatId, name, lastMessage, lastTimestamp, unreadCount, kind, avatarUrl)
    VALUES(@sessionId, @chatId, @name, @lastMessage, @lastTimestamp, @unreadCount, @kind, @avatarUrl)
    ON CONFLICT(sessionId, chatId) DO UPDATE SET
      name=excluded.name,
      lastMessage=excluded.lastMessage,
      lastTimestamp=excluded.lastTimestamp,
      unreadCount=excluded.unreadCount,
      kind=excluded.kind,
      avatarUrl=excluded.avatarUrl
  `);
    stmt.run({ sessionId, chatId, name, lastMessage, lastTimestamp, unreadCount, kind, avatarUrl });
}

function insertMessage({ sessionId, chatId, msgId, fromMe, author, body, timestamp }) {
    const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages(sessionId, chatId, msgId, fromMe, author, body, timestamp)
    VALUES(@sessionId, @chatId, @msgId, @fromMe, @author, @body, @timestamp)
  `);
    stmt.run({ sessionId, chatId, msgId, fromMe: fromMe ? 1 : 0, author, body, timestamp });
}

function listChats(sessionId) {
    return db.prepare(`
    SELECT sessionId, chatId, name, lastMessage, lastTimestamp, unreadCount, kind, avatarUrl
    FROM chats
    WHERE sessionId=?
    ORDER BY COALESCE(lastTimestamp,0) DESC
    LIMIT 300
  `).all(sessionId);
}

function listMessages(sessionId, chatId, limit = 80) {
    return db.prepare(`
    SELECT sessionId, chatId, msgId, fromMe, author, body, timestamp
    FROM messages
    WHERE sessionId=? AND chatId=?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(sessionId, chatId, limit).reverse();
}

function deleteSessionData(sessionId) {
    db.prepare(`DELETE FROM messages WHERE sessionId=?`).run(sessionId);
    db.prepare(`DELETE FROM chats WHERE sessionId=?`).run(sessionId);
}

module.exports = {
    db,
    upsertChat,
    insertMessage,
    listChats,
    listMessages,
    deleteSessionData,
};