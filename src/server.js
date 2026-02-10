import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile } from 'fs/promises';
import { createHash } from 'crypto';
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
const API_KEY = process.env.API_KEY || '';

let server = null;

export function startServer(port = 3456) {
    const app = express();

    // CORS — allow injected script on web.whatsapp.com to call our API
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    app.use(express.json({ limit: '50mb' }));

    // ─── Simple Auth ───
    const AUTH_TOKEN = API_KEY ? createHash('sha256').update(API_KEY).digest('hex').substring(0, 32) : '';

    function parseCookies(req) {
        const cookies = {};
        (req.headers.cookie || '').split(';').forEach(c => {
            const [k, v] = c.trim().split('=');
            if (k) cookies[k] = v;
        });
        return cookies;
    }

    // Auth middleware — protect dashboard & API (except ingest and POST messages)
    function authMiddleware(req, res, next) {
        // Skip auth if no API_KEY is set
        if (!API_KEY) return next();

        // Allow scraper endpoints without cookie auth
        if (req.path === '/api/ingest') return next();
        if (req.path === '/api/messages' && req.method === 'POST') return next();

        // Allow login page and login API
        if (req.path === '/login' || req.path === '/api/auth/login') return next();

        // Allow static assets (css, js, images)
        if (req.path.match(/\.(css|js|ico|png|jpg|jpeg|webp|svg|woff2?)$/)) return next();

        // Check auth cookie
        const cookies = parseCookies(req);
        if (cookies.watools_auth === AUTH_TOKEN) return next();

        // Not authenticated — redirect to login
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        return res.redirect('/login');
    }

    app.use(authMiddleware);

    // Login page
    app.get('/login', (req, res) => {
        const cookies = parseCookies(req);
        if (API_KEY && cookies.watools_auth === AUTH_TOKEN) {
            return res.redirect('/');
        }
        res.send(getLoginPageHtml());
    });

    // Login API
    app.post('/api/auth/login', express.urlencoded({ extended: false }), (req, res) => {
        const { password } = req.body;
        if (password === API_KEY) {
            res.setHeader('Set-Cookie', `watools_auth=${AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`);
            return res.redirect('/');
        }
        res.send(getLoginPageHtml('Wrong password'));
    });

    // Logout
    app.get('/logout', (req, res) => {
        res.setHeader('Set-Cookie', 'watools_auth=; HttpOnly; Path=/; Max-Age=0');
        res.redirect('/login');
    });

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

    // Remote Ingest — receives messages from local scraper
    app.post('/api/ingest', async (req, res) => {
        // Validate API key
        if (!API_KEY) {
            return res.status(500).json({ error: 'API_KEY not configured on server' });
        }
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '');
        if (token !== API_KEY) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        try {
            const { chatName, messages } = req.body;
            if (!chatName || !messages || !Array.isArray(messages)) {
                return res.status(400).json({ error: 'Missing chatName or messages' });
            }

            // Process media (save base64 images to disk)
            for (const msg of messages) {
                if (msg.mediaData) {
                    try {
                        const matches = msg.mediaData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                        if (matches && matches.length === 3) {
                            const ext = matches[1].split('/')[1] || 'jpg';
                            const buffer = Buffer.from(matches[2], 'base64');
                            const filename = `img_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.${ext}`;
                            const filepath = join(__dirname, '..', 'public', 'media', filename);
                            await writeFile(filepath, buffer);
                            msg.mediaUrl = `/media/${filename}`;
                            delete msg.mediaData;
                            console.log(`🖼️ Saved image to ${filename}`);
                        }
                    } catch (mediaErr) {
                        console.error('Media processing error:', mediaErr.message);
                    }
                }
            }

            insertMessages(chatName, messages);
            console.log(`📥 Ingested ${messages.length} messages from "${chatName}" (remote)`);
            res.json({ success: true, count: messages.length, chatName });
        } catch (err) {
            console.error('Ingest error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // QR Code Screenshot (for remote scanning in Docker/VPS)
    app.get('/api/qr', async (req, res) => {
        try {
            const { getQRScreenshot } = await import('./browser.js');
            const screenshot = await getQRScreenshot();
            res.send(`
                <html>
                <head><title>WATools - QR Code</title>
                <meta http-equiv="refresh" content="3">
                <style>body{background:#111;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;flex-direction:column;font-family:sans-serif;color:#fff}
                img{max-width:90%;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.5)}
                p{margin-top:16px;opacity:0.6;font-size:14px}</style></head>
                <body>
                    <img src="data:image/png;base64,${screenshot}" />
                    <p>🔄 Auto-refreshing every 3 seconds... Scan the QR code with your phone.</p>
                </body></html>
            `);
        } catch (err) {
            res.status(500).send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh"><h2>⏳ Browser not ready yet... <br><small style="opacity:0.5">Refresh in a few seconds</small></h2></body></html>`);
        }
    });

    // Health check
    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    return new Promise((resolve) => {
        server = app.listen(port, '0.0.0.0', () => {
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

function getLoginPageHtml(error = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WATools — Login</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0b141a;
            color: #e9edef;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        .login-card {
            background: #1f2c33;
            border-radius: 12px;
            padding: 40px;
            width: 100%;
            max-width: 380px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .login-header {
            text-align: center;
            margin-bottom: 32px;
        }
        .login-header h1 {
            font-size: 1.5rem;
            margin-bottom: 8px;
        }
        .login-header p {
            color: #8696a0;
            font-size: 0.9rem;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #8696a0;
            font-size: 0.85rem;
        }
        input[type="password"] {
            width: 100%;
            padding: 12px 16px;
            background: #111b21;
            border: 1px solid #2a3942;
            border-radius: 8px;
            color: #e9edef;
            font-size: 1rem;
            outline: none;
            transition: border-color 0.2s;
        }
        input[type="password"]:focus {
            border-color: #00a884;
        }
        button {
            width: 100%;
            padding: 12px;
            background: #00a884;
            border: none;
            border-radius: 8px;
            color: white;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
        }
        button:hover { background: #06cf9c; }
        .error {
            background: rgba(233, 68, 68, 0.15);
            color: #e94444;
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 0.9rem;
            margin-bottom: 16px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="login-card">
        <div class="login-header">
            <h1>📱 WATools</h1>
            <p>Enter password to access the dashboard</p>
        </div>
        ${error ? '<div class="error">' + error + '</div>' : ''}
        <form method="POST" action="/api/auth/login">
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" placeholder="Enter API key..." autofocus required>
            </div>
            <button type="submit">Login</button>
        </form>
    </div>
</body>
</html>`;
}
