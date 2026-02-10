import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'messages.db');

let db;

export function initDB() {
  const dataDir = dirname(DB_PATH);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'personal',
      last_message_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      whatsapp_id TEXT UNIQUE,
      chat_id INTEGER NOT NULL,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      type TEXT DEFAULT 'text',
      is_outgoing INTEGER DEFAULT 0,
      media_url TEXT,
      raw_data TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(whatsapp_id);
    CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(whatsapp_id);

    -- FTS5 Virtual Table
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, sender, chat_name);

    -- Triggers to keep FTS synced
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, sender, chat_name)
      SELECT new.id, new.content, new.sender, name FROM chats WHERE id = new.chat_id;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
      INSERT INTO messages_fts(rowid, content, sender, chat_name)
      SELECT new.id, new.content, new.sender, name FROM chats WHERE id = new.chat_id;
    END;
  `);

  // Backfill FTS if empty (checks simply by count, crude but effective for single-user dev)
  const ftsCount = db.prepare('SELECT COUNT(*) as c FROM messages_fts').get().c;
  const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  if (ftsCount < msgCount) {
    console.log('🔄 Backfilling FTS index...');
    db.exec(`
          INSERT INTO messages_fts(rowid, content, sender, chat_name)
          SELECT m.id, m.content, m.sender, c.name
          FROM messages m
          JOIN chats c ON m.chat_id = c.id
          WHERE m.id NOT IN (SELECT rowid FROM messages_fts);
        `);
    console.log('✅ FTS Backfill complete');
  }

  console.log('✅ Database initialized at', DB_PATH);
  return db;
}

// Prepared statements (cached after first call)
let stmtUpsertChat;
let stmtSelectChat;
let stmtInsertMsg;

function getStmts() {
  if (!stmtUpsertChat) {
    stmtUpsertChat = db.prepare(`
      INSERT INTO chats (name, type, last_message_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        last_message_at = datetime('now'),
        type = excluded.type
    `);
    stmtSelectChat = db.prepare('SELECT id FROM chats WHERE name = ?');
    stmtInsertMsg = db.prepare(`
      INSERT INTO messages (whatsapp_id, chat_id, sender, content, timestamp, type, is_outgoing, media_url, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(whatsapp_id) DO UPDATE SET
        timestamp = CASE WHEN excluded.timestamp LIKE '____-__-__T%' THEN excluded.timestamp ELSE timestamp END,
        media_url = COALESCE(media_url, excluded.media_url)
    `);
  }
}

export function upsertChat(name, type = 'personal') {
  getStmts();
  stmtUpsertChat.run(name, type);
  const row = stmtSelectChat.get(name);
  return Number(row.id);
}

export function insertMessages(chatName, messages) {
  getStmts();

  // First upsert the chat OUTSIDE the transaction
  const chatId = upsertChat(chatName);

  // Verify chatId is valid
  if (!chatId || chatId <= 0) {
    throw new Error('Invalid chatId: ' + chatId + ' for chat: ' + chatName);
  }

  let inserted = 0;

  const insertMany = db.transaction((msgs) => {
    for (const msg of msgs) {
      try {
        const result = stmtInsertMsg.run(
          msg.id || null, // whatsapp_id
          chatId,
          msg.sender || null,
          msg.content || null,
          msg.timestamp || null,
          msg.type || 'text',
          msg.isOutgoing ? 1 : 0,
          msg.mediaUrl || null,
          msg.rawData || null,
        );
        if (result.changes > 0) inserted++;
      } catch (err) {
        // Log but don't throw on individual message errors
        console.error('  ⚠️ Skipping message:', err.message);
      }
    }
  });

  insertMany(messages);
  return { chatId, inserted, total: messages.length };
}

export function getChats() {
  return db.prepare(`
    SELECT c.*, COUNT(m.id) as message_count
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    GROUP BY c.id
    ORDER BY c.last_message_at DESC
  `).all();
}

export function getMessages(chatId, limit = 500, offset = 0) {
  return db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(Number(chatId), limit, offset);
}

export function getChatByName(name) {
  return db.prepare('SELECT * FROM chats WHERE name = ?').get(name);
}

export function searchMessages(query, limit = 100) {
  // Use FTS5 for search
  // We sanitize the query by wrapping it in double quotes for phrase search,
  // or append * for prefix search on the last word.
  // For simplicity, we just pass the query. If it fails (syntax error), we fallback or catch.

  // Simple sanitization: remove non-alphanumeric chars that are special in FTS5 usually?
  // FTS5 allows " AND OR NOT etc.
  // A simplified approach: treat as exact phrase or words.

  // User expectation modification: "hello world" -> match phrase? or match both?
  // Let's wrap in quotes for "simple string match" behavior closest to LIKE, 
  // but FTS is word-based.

  // Let's try standard word matching.

  try {
    // Construct a safe query: split by space, add * to each word for prefix matching
    // "he wor" -> "he* wor*"
    const ftsQuery = query.trim().split(/\s+/).map(w => `"${w}"*`).join(' AND ');

    return db.prepare(`
        SELECT m.*, c.name as chat_name
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        JOIN chats c ON c.id = m.chat_id
        WHERE messages_fts MATCH ? 
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(ftsQuery, limit);
  } catch (e) {
    console.error('FTS Search Error:', e.message);
    // Fallback or empty
    return [];
  }
}

export function getStats() {
  const chatCount = db.prepare('SELECT COUNT(*) as count FROM chats').get().count;
  const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const latestMessage = db.prepare('SELECT MAX(created_at) as latest FROM messages').get().latest;
  return { chatCount: Number(chatCount), messageCount: Number(messageCount), latestMessage };
}

export function closeDB() {
  stmtUpsertChat = null;
  stmtSelectChat = null;
  stmtInsertMsg = null;
  if (db) {
    db.close();
    console.log('📦 Database closed');
  }
}
