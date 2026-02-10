# WATools — WhatsApp Message Logger

Safe, browser-based WhatsApp message logger. Uses a real Chrome browser (not headless) with Puppeteer + stealth plugin to passively read messages from the DOM. No API hooking, no WebSocket interception, no message sending.

## How It Works

1. Opens Chrome with WhatsApp Web
2. You scan the QR code (first time only — session is persisted)
3. Browse your chats normally in the Chrome window
4. Messages are automatically logged to a local SQLite database
5. View/search your logged messages at `http://localhost:3456`

## Quick Start

```bash
# Install dependencies
npm install

# Start (opens browser + dashboard)
npm start

# View logged messages only (no browser)
npm run dashboard
```

## Safety

- **Read-only** — never sends messages or modifies WhatsApp
- **Real browser** — uses a visible Chrome window, not headless
- **Session persistence** — QR scan required only once
- **Stealth plugin** — avoids bot detection fingerprinting
- **Passive DOM reading** — only reads what's rendered on screen (like a screen reader)

## Dashboard

Open `http://localhost:3456` to:
- Browse all logged chats
- View message history per chat
- Search across all messages
- Export chat history as text file

## Data

- Messages are stored in `data/messages.db` (SQLite)
- Browser session is stored in `browser-data/`
- Both directories are gitignored

## Deployment (Docker)

To deploy to a VPS:

1. **Clone the repository**
   ```bash
   git clone https://github.com/tesmo/watools.git
   cd watools
   ```

2. **Start the container**
   ```bash
   docker-compose up -d
   ```

3. **Scan QR Code**
   Check the logs to see the QR code URL or ASCII art (if supported), or use the browser's remote debugging if configured.
   ```bash
   docker-compose logs -f
   ```
   *Note: Since this runs in a headless environment by default in Docker, you might need to enable port forwarding or VNC to scan the QR code initially if the console output isn't sufficient.*

