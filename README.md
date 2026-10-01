# deepseek-cli

Browser-automated CLI for [chat.deepseek.com](https://chat.deepseek.com) built with Playwright.

## What it does

- Reuses your local browser session (no login flow, no API key)
- Lets you pick an existing chat or start a new one
- Toggles DeepThink / Search via CLI flags
- Sends prompts and returns the **exact markdown** from DeepSeek's Copy button

## Usage

```bash
npm install
npm run build
npm start                              # DeepThink on, Search off
npm start -- --no-deep-think           # both off
npm start -- --search                  # both on
```

## Requirements

- Node 18+
- A system-installed Chrome, Edge, or Firefox
- You must be logged in to chat.deepseek.com in that browser once (the profile is cached in `./.profile`)

## Notes

The `.profile/` directory stores your session. It is git-ignored and should never be committed.