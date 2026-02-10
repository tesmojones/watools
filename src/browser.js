import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile } from 'fs/promises';
import { getInjectionScript } from './scraper.js';
import { insertMessages } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = join(__dirname, '..', 'browser-data');

// Add stealth plugin to avoid bot detection
puppeteer.use(StealthPlugin());

const isProduction = process.env.NODE_ENV === 'production';

let browser = null;
let page = null;
let injectionInterval = null;

export async function launchBrowser() {
    console.log('🌐 Launching browser...');

    browser = await puppeteer.launch({
        headless: isProduction ? 'new' : false,
        userDataDir: USER_DATA_DIR,
        defaultViewport: isProduction ? { width: 1280, height: 900 } : null,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1280,900',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const pages = await browser.pages();
    page = pages[0] || await browser.newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // ─── Expose bridge function ───
    // This creates window.__watools_saveMessages() in the page context
    // that calls our Node.js function directly — bypassing CSP/CORS
    const remoteUrl = process.env.REMOTE_API_URL;
    const apiKey = process.env.API_KEY;

    await page.exposeFunction('__watools_saveMessages', async (chatName, messagesJSON) => {
        try {
            const messages = JSON.parse(messagesJSON);
            console.log(`📨 Received ${messages.length} messages from "${chatName}"`);

            // ─── REMOTE MODE: send to cloud API ───
            if (remoteUrl && apiKey) {
                // Split messages: those with media need individual sends (large payload)
                const withMedia = messages.filter(m => m.mediaData);
                const withoutMedia = messages.filter(m => !m.mediaData);

                let totalSent = 0;

                // Send text-only messages in one batch
                if (withoutMedia.length > 0) {
                    try {
                        const resp = await fetch(`${remoteUrl}/api/ingest`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${apiKey}`,
                            },
                            body: JSON.stringify({ chatName, messages: withoutMedia }),
                        });
                        const r = await resp.json();
                        if (r.success) totalSent += r.count;
                        else console.error('☁️ Text ingest error:', r.error);
                    } catch (e) {
                        console.error('☁️ Text send failed:', e.message);
                    }
                }

                // Send media messages one by one (large base64 payloads)
                for (const msg of withMedia) {
                    try {
                        const resp = await fetch(`${remoteUrl}/api/ingest`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${apiKey}`,
                            },
                            body: JSON.stringify({ chatName, messages: [msg] }),
                        });
                        const r = await resp.json();
                        if (r.success) {
                            totalSent += 1;
                            console.log(`🖼️☁️ Sent image to cloud`);
                        } else {
                            console.error('🖼️☁️ Image ingest error:', r.error);
                        }
                    } catch (e) {
                        console.error('🖼️☁️ Image send failed:', e.message);
                    }
                }

                console.log(`☁️ Sent ${totalSent} messages to cloud (${withMedia.length} with images) — ${chatName}`);
                return JSON.stringify({ success: true, count: totalSent });
            }

            // ─── LOCAL MODE: save to local DB ───
            // Process media files
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
                    } catch (e) {
                        console.error('Failed to save image:', e);
                    }
                }
            }

            const result = insertMessages(chatName, messages);
            if (result.inserted > 0) {
                console.log(`💾 Saved ${result.inserted}/${result.total} messages (chatId: ${result.chatId})`);
            }
            return JSON.stringify({ inserted: result.inserted, total: result.total });
        } catch (err) {
            console.error('❌ Bridge error:', err.message);
            console.error('   Stack:', err.stack?.split('\n').slice(0, 3).join('\n'));
            return JSON.stringify({ inserted: 0, error: err.message });
        }
    });

    // Navigate to WhatsApp Web
    console.log('📱 Opening WhatsApp Web...');
    await page.goto('https://web.whatsapp.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });

    console.log('⏳ Waiting for login (scan QR code if needed)...');

    try {
        await page.waitForSelector(
            '#pane-side, [data-testid="qrcode"], canvas[aria-label]',
            { timeout: 60000 }
        );

        const qrVisible = await page.$('[data-testid="qrcode"]') || await page.$('canvas[aria-label]');
        if (qrVisible) {
            console.log('📷 QR code detected — please scan it with your phone');
            await page.waitForSelector('#pane-side', { timeout: 300000 });
        }

        console.log('✅ WhatsApp Web logged in!');
    } catch (err) {
        console.log('⏳ Still loading... will keep trying to inject script');
    }

    // Start injection loop
    startInjectionLoop();

    page.on('error', (err) => {
        console.error('❌ Page crashed:', err.message);
    });

    browser.on('disconnected', () => {
        console.log('🔌 Browser disconnected');
        stopInjectionLoop();
        browser = null;
        page = null;
    });

    return { browser, page };
}

function startInjectionLoop() {
    tryInject();
    injectionInterval = setInterval(tryInject, 3000);
}

function stopInjectionLoop() {
    if (injectionInterval) {
        clearInterval(injectionInterval);
        injectionInterval = null;
    }
}

async function tryInject() {
    if (!page || page.isClosed()) return;

    try {
        const isReady = await page.evaluate(() => !!document.querySelector('#pane-side'));
        if (!isReady) return;

        const isInjected = await page.evaluate(() => !!window.__watools_injected);
        if (isInjected) return;

        console.log('💉 Injecting observer script...');
        const script = getInjectionScript();

        await page.evaluate((code) => {
            const fn = new Function(code);
            fn();
        }, script);

        const verified = await page.evaluate(() => ({
            injected: !!window.__watools_injected,
            bridge: typeof window.__watools_saveMessages === 'function',
            chatName: window.__watools?.getChatName?.() || '(no chat open)',
        }));

        if (verified.injected && verified.bridge) {
            console.log('✅ Observer script injected and bridge connected!');
            console.log('📱 Current chat:', verified.chatName);
        } else {
            console.log('⚠️ Injection status:', JSON.stringify(verified));
        }
    } catch (err) {
        if (!err.message.includes('Execution context was destroyed') &&
            !err.message.includes('Target closed')) {
            // Only log non-expected errors
        }
    }
}

export async function closeBrowser() {
    stopInjectionLoop();
    if (browser) {
        console.log('🔌 Closing browser...');
        await browser.close();
        browser = null;
        page = null;
    }
}

export function getBrowser() {
    return browser;
}

export function getPage() {
    return page;
}

export async function triggerManualSync(targetChatName) {
    if (!page || page.isClosed()) {
        throw new Error('Browser not connected');
    }

    try {
        const result = await page.evaluate(async (chatName) => {
            if (window.__watools && window.__watools.forceSync) {
                return await window.__watools.forceSync(chatName);
            }
            return { error: 'WATools script not injected yet' };
        }, targetChatName);
        return result;
    } catch (err) {
        console.error('Manual sync error:', err);
        throw err;
    }
}

// Take a screenshot of the current page (useful for scanning QR code remotely)
export async function getQRScreenshot() {
    if (!page || page.isClosed()) {
        throw new Error('Browser not connected');
    }
    return await page.screenshot({ encoding: 'base64', type: 'png' });
}
