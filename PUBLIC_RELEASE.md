# SACHi-MD V8 — Public Release Checklist

## Before publishing
- [ ] Replace placeholder GitHub / WhatsApp / Telegram links in `index.html`.
- [ ] Review `settings.js` and change owner/bot branding.
- [ ] Set a strong `WEB_API_KEY` on the bot host if the API is public.
- [ ] Confirm the pairing endpoint is protected appropriately.
- [ ] Keep `session/`, `.env`, API keys and credentials out of GitHub.
- [ ] Use persistent storage for WhatsApp session data.
- [ ] Test `.ping`, `.menu`, owner commands and group-admin commands.
- [ ] Test pairing from a fresh browser.
- [ ] Test mobile layout.
- [ ] If using Quick Tunnel, remember its URL can change after a restart; a stable domain is better for a public release.
- [ ] Add your real support/community links.
- [ ] Review Terms/Privacy text for your actual deployment.

## Recommended repository settings
1. Enable GitHub Pages using the included Pages workflow.
2. Add deployment secrets only through GitHub/host secret storage.
3. Protect the `main` branch if multiple people will contribute.
4. Do not commit WhatsApp auth/session files.

## Public website
The website includes:
- Pairing
- Live health status
- Searchable command directory
- Bot updates
- Community/support links
- Terms
- Privacy
- Deployment guidance


## Official social links configured
- TikTok: https://www.tiktok.com/@sachinthagayan915
- Instagram: https://www.instagram.com/sachintha5275
- Facebook: https://www.facebook.com/share/1KR7Xbrjcn/
- WhatsApp: https://wa.me/94778936490
