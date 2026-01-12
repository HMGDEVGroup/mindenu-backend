# Mindenu Backend (Node/Express)

This backend holds **all secrets** (OpenAI key + OAuth client secrets) and exposes a small REST API
that your iOS app calls. The iOS app never receives these secrets.

## Endpoints

- `GET  /health`
- `POST /v1/chat` (requires Firebase ID token)
- `GET  /v1/oauth/google/start`
- `GET  /v1/oauth/google/callback`
- `GET  /v1/oauth/microsoft/start`
- `GET  /v1/oauth/microsoft/callback`
- `POST /v1/actions/create-event` (requires Firebase ID token)
- `POST /v1/actions/send-email` (requires Firebase ID token)

## Setup
1. `cp .env.example .env` and fill values
2. `npm i`
3. `npm run dev`

## Notes
- Token storage in this starter kit is **in-memory** for clarity. Replace `tokenStore.js` with a real DB
  (Postgres, Redis, etc.) and encrypt refresh tokens.
- OAuth is implemented as a **backend redirect** flow (start -> provider -> callback -> deep link back to app).
# mindenu-backend
