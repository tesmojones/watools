import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import {
    insertMessages,
    getChats,
    getMessages,
    getChatByName,
    searchMessages,
    getStats,
} from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let server = null;

export function startServer(port = 3456) {
    const app = express();

    // CORS — allow injected script on web.whatsapp.com to call our API
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    app.use(express.json({ limit: '10mb' }));
    app.use(express.static(join(__dirname, '..', 'public')));

    // ─── API Routes ───

    // Receive messages from injected script
    app.post('/api/messages', (req, res) => {
        try {
            const { chatName, messages } = req.body;

            if (!chatName || !messages || !Array.isArray(messages)) {
                return res.status(400).json({ error: 'Invalid payload' });
            }

            const result = insertMessages(chatName, messages);
            res.json({
                success: true,
                inserted: result.inserted,
                total: result.total,
                chatId: result.chatId,
            });
        } catch (err) {
            console.error('❌ Error saving messages:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Get all chats
    app.get('/api/chats', (req, res) => {
        try {
            const chats = getChats();
            res.json(chats);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get messages for a chat
    app.get('/api/messages/:chatId', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 500;
            const offset = parseInt(req.query.offset) || 0;
            const messages = getMessages(parseInt(req.params.chatId), limit, offset);
            res.json(messages);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Search messages
    app.get('/api/search', (req, res) => {
        try {
            const query = req.query.q || '';
            if (!query) return res.json([]);
            const results = searchMessages(query);
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get stats
    app.get('/api/stats', (req, res) => {
        try {
            const stats = getStats();
            res.json(stats);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get metadata for URL preview
    app.get('/api/metadata', async (req, res) => {
        try {
            const { url } = req.query;
            if (!url) return res.status(400).json({ error: 'Missing url parameter' });

            // Validate URL
            try {
                new URL(url);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid URL' });
            }

            console.log(`🔗 Fetching metadata for: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                redirect: 'follow',
                signal: AbortSignal.timeout(5000) // 5s timeout
            });

            if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);

            const html = await response.text();
            const $ = cheerio.load(html);

            const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
            const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
            let image = $('meta[property="og:image"]').attr('content') || '';

            // Resolve relative image URLs
            if (image && !image.startsWith('http')) {
                try {
                    image = new URL(image, url).toString();
                } catch (e) { }
            }

            res.json({ title, description, image, url });
        } catch (err) {
            // Return empty metadata on error instead of 500 effectively
            res.json({ error: err.message });
        }
    });

    // Manual Sync
    app.post('/api/sync', async (req, res) => {
        try {
            const { chatName } = req.body;
            const { triggerManualSync } = await import('./browser.js');
            const result = await triggerManualSync(chatName);
            res.json(result);
        } catch (err) {
            console.error('Sync failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Health check
    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    return new Promise((resolve) => {
        server = app.listen(port, () => {
            console.log(`🖥️  Dashboard: http://localhost:${port}`);
            console.log(`📡 API:       http://localhost:${port}/api`);
            resolve(server);
        });
    });
}

export function stopServer() {
    return new Promise((resolve) => {
        if (server) {
            server.close(() => {
                console.log('🛑 Server stopped');
                resolve();
            });
        } else {
            resolve();
        }
    });
}
