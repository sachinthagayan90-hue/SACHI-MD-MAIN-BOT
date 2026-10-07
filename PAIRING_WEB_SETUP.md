# SACHi-MD V8 Pairing Web

## Bot server
1. Set `PAIRING_NUMBER` in `settings.js` to the WhatsApp number to pair.
2. Optional: set environment variable `WEB_API_KEY` to protect the pairing endpoint.
3. Deploy the bot on a Node.js 20+ host.
4. The bot exposes:
   - `GET /api/health`
   - `GET /api/pair?phone=947xxxxxxxxx`
5. The web page calls `/api/pair` and shows the pairing code.

## GitHub Pages
Upload `index.html` to a GitHub repository and enable GitHub Pages.
In the page, enter the public URL of the bot server in **Bot API URL**.
If `WEB_API_KEY` is enabled on the bot server, enter the same key in the page.

## WhatsApp
Use: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then enter the displayed code.

Do not commit session credentials or `.env` secrets to GitHub.


## Owner Dashboard
The web page now includes an Owner Control Center. Set `WEB_API_KEY` on the bot host, then enter the same key in the Owner panel. It can safely display:
- WhatsApp session connection status and runtime
- active bot users and recent command logs
- runtime settings such as prefix, auto reply/react/read/status, anti-delete and view-once alerts
- block/unblock controls
- restart and stop/logout actions

Session credentials remain on the bot host and are never displayed by the dashboard.
