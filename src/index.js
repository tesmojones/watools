import { initDB, closeDB } from './database.js';
import { startServer, stopServer } from './server.js';
import { launchBrowser, closeBrowser } from './browser.js';
import { exec } from 'child_process';

const PORT = 3456;
const dashboardOnly = process.argv.includes('--dashboard-only');

async function main() {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║    📱 WATools — Message Logger       ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');

    // Initialize database
    initDB();

    // Start Express server
    await startServer(PORT);

    // Auto-open dashboard in default browser (skip in production/Docker)
    const isProduction = process.env.NODE_ENV === 'production';
    if (!dashboardOnly && !isProduction) {
        console.log('📊 Opening dashboard in default browser...');
        const startCommand = process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${startCommand} http://localhost:${PORT}`, (err) => {
            if (err) console.error('⚠️ Failed to auto-open dashboard:', err.message);
        });
    } else if (isProduction) {
        console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    }

    if (dashboardOnly) {
        console.log('');
        console.log('📊 Dashboard-only mode');
        console.log(`   Open http://localhost:${PORT} to view your logged messages`);
        console.log('');
    } else {
        // Launch browser with WhatsApp Web
        console.log('');
        await launchBrowser();
        console.log('');
        console.log('═══════════════════════════════════════');
        console.log('  ✅ Everything is running!');
        console.log('  📱 Use the Chrome window to browse WhatsApp');
        console.log(`  📊 Dashboard: http://localhost:${PORT}`);
        console.log('  🛑 Press Ctrl+C to stop');
        console.log('═══════════════════════════════════════');
        console.log('');
    }
}

// Graceful shutdown
async function shutdown() {
    console.log('');
    console.log('🛑 Shutting down...');
    await closeBrowser();
    await stopServer();
    closeDB();
    console.log('👋 Goodbye!');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled rejection:', err);
});

main().catch((err) => {
    console.error('❌ Fatal error:', err);
    shutdown();
});
