# SACHi-MD Ultimate AI Assistant

Includes the previous SACHi-MD features plus:

## Inbox Anti-Badword
- `.antibadword on/off` — owner-only control from the bot owner's inbox.
- `.addbadword <word>` — add any custom blocked word/phrase for private inbox chats.
- `.delbadword <word>` — remove a custom blocked word/phrase.
- `.badwords` — view default + custom inbox blocked words.
- When enabled, matching incoming private-chat messages are deleted when possible and the sender receives a warning.
- The owner's self-chat is never filtered.
- Group anti-badword remains separate and continues to use the existing per-group settings.

## User system
- `.profile` / `.me`
- `.profilename <name>`
- `.setbio <text>`
- `.leveltitle`
- XP, levels, coins and premium status

## Music player
- `.play <song name or YouTube URL>`
- `.queue`
- `.skip`
- `.nowplaying`
- `.music`

## Smart AI
- `SACHi <question>` or mention the bot for AI
- `.ai <question>`
- Group `.smartai on/off` for automatic AI replies to normal group messages (admin-only)

Requires `AI_API_URL` and `AI_API_KEY` in `settings.js`.
