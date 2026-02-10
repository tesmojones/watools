import { launchBrowser, closeBrowser } from './browser.js';

const PORT = 3456;

async function main() {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║  📱 WATools — Scraper Mode           ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');

    const remoteUrl = process.env.REMOTE_API_URL;
    const apiKey = process.env.API_KEY;

    if (!remoteUrl || !apiKey) {
        console.error('❌ Missing REMOTE_API_URL or API_KEY in .env');
        console.error('   Create a .env file with:');
        console.error('     REMOTE_API_URL=https://wa.tesmo.my.id');
        console.error('     API_KEY=your-secret-key');
        process.exit(1);
    }

    console.log(`☁️ Remote API: ${remoteUrl}`);
    console.log('');

    // Launch browser with WhatsApp Web
    await launchBrowser();

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  ✅ Scraper is running!');
    console.log('  📱 Use the Chrome window to browse WhatsApp');
    console.log(`  ☁️  Messages are sent to: ${remoteUrl}`);
    console.log('  🛑 Press Ctrl+C to stop');
    console.log('═══════════════════════════════════════');
    console.log('');
}

// Graceful shutdown
async function shutdown() {
    console.log('');
    console.log('🛑 Shutting down...');
    await closeBrowser();
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
