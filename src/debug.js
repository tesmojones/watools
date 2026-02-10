/**
 * Debug script — connects to the running Puppeteer browser and inspects the WhatsApp Web DOM
 * to find the correct CSS selectors for message extraction.
 */
import puppeteer from 'puppeteer';

async function debug() {
    // Connect to the Puppeteer browser that npm start launched
    // Check which port it's using
    let browser;

    // The Puppeteer browser uses its own debugging port, not 9222
    // Let's find it by connecting to the user data dir
    const browserURL = 'http://127.0.0.1:9222';

    try {
        // Try connecting to the existing browser
        browser = await puppeteer.connect({ browserURL });
        console.log('✅ Connected to browser');
    } catch (e) {
        console.log('Trying alternate approach...');
        // Get list from CDP
        const res = await fetch('http://localhost:9222/json/list');
        const pages = await res.json();
        const waPage = pages.find(p => p.url.includes('whatsapp'));
        if (!waPage) {
            console.log('❌ No WhatsApp page found');
            process.exit(1);
        }

        browser = await puppeteer.connect({
            browserWSEndpoint: waPage.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'),
        });
        console.log('✅ Connected via alternate method');
    }

    const pages = await browser.pages();
    console.log('Pages:', pages.map(p => p.url()));

    const waPage = pages.find(p => p.url().includes('whatsapp'));
    if (!waPage) {
        console.log('❌ WhatsApp page not found');
        process.exit(1);
    }

    console.log('\n=== Checking injection status ===');
    const injected = await waPage.evaluate(() => typeof window.__watools_injected);
    console.log('Injected:', injected);

    const watoolsObj = await waPage.evaluate(() => typeof window.__watools);
    console.log('WATools obj:', watoolsObj);

    console.log('\n=== Checking DOM structure ===');
    const domInfo = await waPage.evaluate(() => {
        const results = {};

        // Basic structure
        results.paneSide = !!document.querySelector('#pane-side');
        results.main = !!document.querySelector('#main');
        results.mainHeader = !!document.querySelector('#main header');

        // Chat name detection
        const headerSpans = document.querySelectorAll('#main header span');
        results.headerSpanCount = headerSpans.length;
        results.headerSpanTexts = [...headerSpans].slice(0, 10).map(s => ({
            text: s.textContent?.substring(0, 50),
            title: s.getAttribute('title')?.substring(0, 50),
            dir: s.getAttribute('dir'),
            classes: s.className?.substring(0, 100),
        }));

        // Message selectors
        results.msgContainer = document.querySelectorAll('[data-testid="msg-container"]').length;
        results.messageIn = document.querySelectorAll('.message-in').length;
        results.messageOut = document.querySelectorAll('.message-out').length;
        results.convPanel = !!document.querySelector('[data-testid="conversation-panel-messages"]');
        results.roleApp = !!document.querySelector('#main [role="application"]');

        // All data-testid values related to messages
        results.msgTestIds = [...new Set(
            [...document.querySelectorAll('[data-testid]')]
                .map(e => e.getAttribute('data-testid'))
                .filter(t => t && (
                    t.includes('msg') || t.includes('message') ||
                    t.includes('chat') || t.includes('conversation') ||
                    t.includes('bubble') || t.includes('text') ||
                    t.includes('cell') || t.includes('list')
                ))
        )].slice(0, 40);

        // Check for role="row" which WhatsApp often uses for messages
        results.roleRow = document.querySelectorAll('[role="row"]').length;
        results.roleRowInMain = document.querySelectorAll('#main [role="row"]').length;

        // Look at all classes on elements inside #main
        const mainDiv = document.querySelector('#main');
        if (mainDiv) {
            const allDivs = mainDiv.querySelectorAll('div[class]');
            const classSet = new Set();
            allDivs.forEach(d => {
                d.className.split(' ').forEach(c => {
                    if (c.includes('message') || c.includes('msg') || c.includes('bubble') ||
                        c.includes('text') || c.includes('chat') || c.includes('in') ||
                        c.includes('out') || c.includes('copyable') || c.includes('selectable')) {
                        classSet.add(c);
                    }
                });
            });
            results.relevantClasses = [...classSet].slice(0, 30);
        }

        // Get a sample of the #main inner HTML structure (first 2000 chars)
        const mainEl = document.querySelector('#main');
        if (mainEl) {
            // Get a high level view of the structure
            const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_ELEMENT);
            const structure = [];
            let count = 0;
            while (walker.nextNode() && count < 50) {
                const node = walker.currentNode;
                const depth = getDepth(node, mainEl);
                if (depth <= 6) {
                    structure.push('  '.repeat(depth) + node.tagName +
                        (node.className ? '.' + node.className.split(' ').slice(0, 2).join('.') : '') +
                        (node.getAttribute('role') ? '[role=' + node.getAttribute('role') + ']' : '') +
                        (node.getAttribute('data-testid') ? '[data-testid=' + node.getAttribute('data-testid') + ']' : ''));
                    count++;
                }
            }
            results.mainStructure = structure;
        }

        function getDepth(node, root) {
            let depth = 0;
            while (node && node !== root) {
                node = node.parentElement;
                depth++;
            }
            return depth;
        }

        return results;
    });

    console.log(JSON.stringify(domInfo, null, 2));

    // Don't close, just disconnect
    browser.disconnect();
    console.log('\n✅ Done, browser still running');
}

debug().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
