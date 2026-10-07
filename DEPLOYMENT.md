# SACHi-MD Premium Base — Deployment

## 1. Bot host
Use a persistent Node.js 20+ host. `node start.js` starts the bot and the optional Cloudflare Quick Tunnel.

Supported project files:
- `Procfile` for Heroku-style hosts
- `render.yaml` for Render-style services
- `railway.json` for Railway-style deployments
- `Dockerfile` for Docker hosts
- `.github/workflows/ci.yml` for GitHub validation

**Important:** GitHub Actions is CI/CD, not a 24/7 bot host. Do not use an Actions runner as the permanent WhatsApp process.

## 2. Pairing site
The root `index.html` is the premium public pairing portal. It calls:
- `GET /api/health`
- `GET /api/pair?phone=...`

For a separate GitHub Pages site, the included `pages.yml` publishes the repository.

## 3. Secrets
Never commit:
- WhatsApp session files
- `WEB_API_KEY`
- AI/media API keys

Set `WEB_API_KEY` as a host environment variable and enter the same key in the pairing page when required.

## 4. Persistent session
For production, use a host with persistent storage for the `session/` directory. Ephemeral filesystems can cause the bot to require pairing again after restart.

## 5. Customization
Edit `settings.js` for:
- BOT_NAME
- OWNER_NAME
- OWNER_NUMBER
- PAIRING_NUMBER
- PREFIX
- BOT_DP_URL
- FOOTER
- feature defaults
