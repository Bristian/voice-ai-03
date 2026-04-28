# Slice 5 — Supervisor Dashboard (Live Call Monitoring)

**Goal:** a web dashboard where you can see active calls, read live transcripts as they happen, and review call history.

**What this adds:**
- `dashboard/` — Next.js 14 app with dark theme matching the architecture doc aesthetic
- Active calls panel with real-time status (live/ended), intent, turn count, duration
- Live transcript streaming (partial STT preview + final committed transcripts)
- Call history page with expandable transcripts and extracted entities
- Socket.io event streaming from echokit-server to the dashboard
- Call session persistence — transcripts saved to PostgreSQL when calls end

**What's deferred to a future slice:**
- WebRTC live audio listen-in (requires mediasoup SFU)
- Auth / RBAC (NextAuth.js with manager/agent roles)
- "Transfer to Me" call takeover button

**Time estimate:** 20–30 minutes.

---

## What changed

### echokit-server (new + modified)
- **`src/supervisor.js` (new)** — Socket.io server on `/supervisor` path. Emits events: `call_started`, `transcript_partial`, `transcript_final`, `intent_classified`, `agent_response`, `call_ended`
- **`src/websocket.js` (modified)** — emits supervisor events at each stage of the call pipeline. Saves call session to agent-api when call ends.
- **`src/server.js` (modified)** — attaches Socket.io server to HTTP server
- **`package.json`** — added `socket.io` dependency

### agent-api (modified)
- **`app/main.py`** — added `POST /v1/sessions` (save), `GET /v1/sessions` (list), `GET /v1/sessions/{uuid}` (detail)

### dashboard (new service)
- **`app/page.js`** — active calls with live transcripts via Socket.io
- **`app/history/page.js`** — call history from agent-api
- **`lib/socket.js`** — Socket.io client singleton
- Dark theme with Tailwind matching the architecture doc colors

---

## 1. Upload the code to GitHub

```bash
cd your-local-repo
git add -A
git commit -m "slice 5: supervisor dashboard + call session persistence"
git push
```

---

## 2. Create the dashboard service on Railway

1. On the Railway project canvas, click **+ New** → **Empty Service**
2. Name it `dashboard`
3. Click on the tile → **Settings**
4. Under **Source**, connect your GitHub repo
5. Build configuration:
   - **Root Directory:** leave empty
   - **Build Command:** leave empty
   - **Start Command:** leave empty (Dockerfile handles it)
6. Under **Networking**, click **Generate Domain**, port **3001**

---

## 3. Set environment variables on the dashboard

Click `dashboard` → **Variables** tab:

| Variable | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `dashboard/Dockerfile` |
| `NEXT_PUBLIC_ECHOKIT_URL` | Your echokit-server public URL (e.g., `https://echokit-server-production-xxxx.up.railway.app`) |
| `NEXT_PUBLIC_AGENT_API_URL` | Your agent-api public URL (e.g., `https://agent-api-production-xxxx.up.railway.app`) |
| `PORT` | `3001` |

> **Important:** the `NEXT_PUBLIC_` prefix is required — Next.js only exposes env vars to the browser if they start with this prefix.

Railway will auto-deploy.

---

## 4. Verify the deployment

Visit `https://<DASHBOARD-URL>/` in your browser. You should see:
- A dark-themed page with "Voice AI Dashboard" in the nav bar
- "Active Calls" panel on the left showing "No active calls. Waiting for incoming calls…"
- A connection status indicator (● Live / ○ Disconnected)

If it shows **○ Disconnected**, the Socket.io connection to echokit-server isn't working. Check:
1. `NEXT_PUBLIC_ECHOKIT_URL` is set correctly (the full `https://...` URL of echokit-server)
2. echokit-server is running (check its `/healthz`)

---

## 5. Test live monitoring

1. Open the dashboard in your browser
2. Call your Vonage number from your phone
3. Watch the dashboard:
   - A new call card appears in the left panel with status **LIVE**
   - Click the card to see the transcript panel
   - As you speak, partial transcripts appear in real time (faded, with "typing…")
   - When STT commits, the final transcript appears as a solid bubble
   - The AI's response appears as an orange-tinted bubble on the right
   - Intent badges update (e.g., "vehicle_search", "dealership_info")
   - When you hang up, the card changes to "ended" and fades out after 30 seconds

---

## 6. Test call history

1. Visit `https://<DASHBOARD-URL>/history`
2. Click **Refresh** (or it loads automatically)
3. You should see past calls with timestamps, outcome, and caller phone (masked)
4. Click a call to expand its transcript
5. The transcript shows caller messages on the left, AI messages on the right
6. Extracted entities (make, body_style, price_max, etc.) appear as tags below

> **Note:** call history only shows calls made AFTER slice 5 is deployed, because call session saving was added in this slice.

---

## 7. Troubleshooting

### "Dashboard shows ○ Disconnected"

The Socket.io connection to echokit-server failed. Check:
1. `NEXT_PUBLIC_ECHOKIT_URL` in dashboard variables — must be the public URL, not internal
2. echokit-server logs — look for `Supervisor Socket.io attached at /supervisor`
3. Browser console (F12) — look for `[Dashboard] Connection error:` messages
4. CORS: the Socket.io server has `cors: { origin: "*" }` so this shouldn't be an issue

### "Calls don't appear on the dashboard"

The call events aren't reaching the dashboard. Check echokit-server logs for:
- `Supervisor dashboard connected` — should appear when you open the dashboard
- If missing, the Socket.io connection never established (see above)

### "Call history page shows error"

`NEXT_PUBLIC_AGENT_API_URL` is wrong or agent-api is down. Test directly:
```
https://<AGENT-API-URL>/v1/sessions
```
Should return `{"sessions": [], "total": 0}` (or with data if you've made calls).

### "Call history is empty even after calls"

Call session saving is fire-and-forget from echokit-server. If it fails silently:
1. Check echokit-server logs for `Failed to save call session`
2. Verify `AGENT_API_URL` is set on echokit-server (not just on dashboard)
3. The session is saved when the call ends — if the call disconnects abnormally, the save may not fire

### "Dashboard build fails on Railway"

Make sure `RAILWAY_DOCKERFILE_PATH` is set to `dashboard/Dockerfile` (not `agent-api/Dockerfile`). Each service needs its own Dockerfile path.

---

## How to know slice 5 is "done"

- [ ] Dashboard is deployed and accessible at its Railway URL
- [ ] Dashboard shows ● Live (Socket.io connected)
- [ ] Making a call: the call appears in the active calls panel
- [ ] Live transcripts stream in real time during the call
- [ ] Call history page shows completed calls with transcripts
- [ ] echokit-server and agent-api still work correctly

---

## What's next

| Slice | Goal |
|---|---|
| 6 | Hardening — call recording, rate limiting, observability, Vonage call transfer, auth |

Reply **"slice 6"** when you're ready to continue.
