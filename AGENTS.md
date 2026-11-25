# AGENTS.md

- **Permissions** — `app/lib/access.server.ts`. Every action calls its own `require*` guard; loader guards leave actions open.
- **`request-logger/`** — separate tool; read `request-logger/CLAUDE.md` before changing it.
