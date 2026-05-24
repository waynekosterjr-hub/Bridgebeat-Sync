# Copilot Instructions

This repository is a single-service Node.js web app with a static frontend.

## What to know
- The backend is `server.js` and uses Express + `dotenv`.
- The frontend is static under `public/` and has no build step.
- Runtime state is stored in `data/sessions.json`; do not treat it as source content.
- OAuth credentials are configured via `.env`, so never commit secrets.

## How to help
- Prefer changes in `server.js` for server behavior and `public/*` for UI behavior.
- Preserve the simple architecture; avoid introducing unnecessary frameworks.
- Link to `AGENTS.md` and `README.md` for startup commands and environment details.
- Use `npm install`, `npm start`, or `npm run dev` to validate changes locally.

## Useful references
- `AGENTS.md` — project-specific guidance for AI agents.
- `README.md` — setup and usage documentation.
- `.env.example` — expected environment variables.
