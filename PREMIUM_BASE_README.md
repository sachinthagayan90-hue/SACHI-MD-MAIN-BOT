# SACHi-MD V8 — Premium Base V2

This package is based on the working SACHi-MD V8 command/event engine and adds a polished public portal.

## Included
- WhatsApp bot command/event engine
- Real pairing-code API (`/api/pair`)
- Health API (`/api/health`)
- Premium responsive web portal
- Searchable command directory (106 recognized command names in this release)
- Bot updates section
- Owner/branding information from `settings.js`
- API-key support
- Docker / Procfile / Render / Railway deployment helpers
- GitHub Actions CI
- GitHub Pages publishing workflow

## Important architecture
GitHub is for source control and CI/CD. A WhatsApp bot should run on a persistent Node.js host with persistent storage for `session/`. GitHub Actions runners are not a 24/7 bot host.

## Public release checklist
1. Change `OWNER_NAME`, `OWNER_NUMBER`, `PAIRING_NUMBER` and branding in `settings.js`.
2. Set a strong `WEB_API_KEY` on the bot host if your public pairing endpoint needs protection.
3. Keep `session/` out of Git (`.gitignore` already covers it).
4. Use persistent disk/storage so the WhatsApp session survives restarts.
5. Put the web portal on GitHub Pages or another static host.
6. Point the portal's API URL at the stable bot API domain.
7. If using Cloudflare Quick Tunnel, remember its public hostname can change after a restart; a stable domain is better for a public release.
8. Test owner-only commands and group-admin permissions before publishing.

## Command directory
The web portal's command list is generated from the current command router rather than being a hand-written list, so it is less likely to advertise commands that are not recognized by the bot.
