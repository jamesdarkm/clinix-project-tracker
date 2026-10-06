# Clinix programme dashboard

The Clinix x DarkMatter 8-week programme board (`public/index.html`), served by a small Node server that saves the board for everyone.

Everything on the board is saved: card status, ticks, owners, hours, notes, added deliverables, timeline and dependency statuses, the activity feed, and the week 1 date set with **Reschedule**. Open tabs pull changes every 5 seconds. Saves merge record by record, so two people editing different cards at the same time keep both changes.

## Deploy on Railway

1. **New Project -> Deploy from GitHub repo** and pick this repo. Railway runs `npm start`, and the health check is `/healthz`.
2. In the same project, **+ New -> Database -> PostgreSQL**.
3. On the app service, open **Variables** and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `DASHBOARD_PASSWORD` = the shared password for the login page. Without it the login is off and anyone with the link can edit or reset the board.
4. **Settings -> Networking -> Generate Domain**.

The server creates its table (`dashboard_state`) on first start. The first person to open the page seeds the board from the proposal scope.

If `DATABASE_URL` is missing, the server falls back to `data/state.json`. On Railway that file is wiped on every redeploy unless you mount a volume and set `DATA_DIR` to its path, so use Postgres.

## Run locally

```
npm install
npm start            # http://localhost:3000, saves to data/state.json
```

## API

- `GET /api/state` returns the saved board, or 404 before the first save
- `PUT /api/state` merges the posted board into the saved one and returns the result
- `GET /healthz` returns `ok` (no password)

## Login

With `DASHBOARD_PASSWORD` set, every page and API call needs a sign-in at `/login`. A session lasts 30 days, and there is a **Log out** button in the header.

- Changing `DASHBOARD_PASSWORD` on Railway signs everyone out. Sessions are signed with a key derived from the password.
- After 10 wrong passwords from one IP address, that address is locked out for 15 minutes.
- `/healthz` and `/logo.png` stay open.
