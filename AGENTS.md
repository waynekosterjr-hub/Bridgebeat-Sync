# AI Coding Agent Instructions

## Project summary
- Single-service Node.js web app.
- Backend: `server.js` with Express and `dotenv`.
- Frontend: static assets under `public/` (`index.html`, `app.js`, `styles.css`).
- Data persistence: `data/sessions.json` stores user sessions and sync state.
- OAuth integration: YouTube and Spotify credentials configured via `.env`.

## Startup commands
- `npm install` to install dependencies.
- `npm start` to run the app in production mode.
- `npm run dev` to run with file-watching on `server.js`.

## Important files
- `server.js` — main server entrypoint, session handling, static file hosting, and sync configuration.
- `public/index.html` — frontend shell and OAuth popup flow.
- `public/app.js` — browser-side sync controls, preview, and status feed.
- `public/styles.css` — app styling.
- `data/sessions.json` — persisted session storage (generated at runtime).
- `.env.example` — environment variable reference for local setup.
- `README.md` — user-facing setup and run instructions.

## Environment and runtime notes
- The project is CommonJS (`type: commonjs` in `package.json`).
- `dotenv` loads environment variables from `.env`.
- `SESSION_SECRET` is required for signed cookies.
- `HTTPS_ENABLED` can enable local HTTPS with certificate paths.
- `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `SPOTIFY_CLIENT_ID`, and `SPOTIFY_CLIENT_SECRET` are required for OAuth.

## Agent guidance
- Preserve the current simple architecture: backend logic lives in `server.js`; frontend UI is static under `public/`.
- Avoid committing secrets or modifying runtime `.env` values directly. Use `.env.example` for docs.
- Do not assume an existing test suite; use `npm start`/`npm run dev` and manual browser verification when validating changes.
- Keep README and environment docs aligned with code changes.
- `data/sessions.json` is runtime state storage, not a source of truth for feature logic.

## Known conventions
- Session state is keyed by signed cookie `sid` and persisted across server restarts.
- Sync options are normalized in `server.js` and use defaults when values are missing.
- The repo currently has no dedicated frontend framework or build step.
