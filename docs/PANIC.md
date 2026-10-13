# PANIC

Something broke and there are judges watching. Work down this page.

**First rule: keep talking.** Narrate what you are showing while you fix. Silence
reads as failure; a running commentary reads as expertise.

**Second rule: there is always a fallback.** §7 is a real rendered video of this
pipeline reading plates. It has never failed.

---

## 0. Thirty-second triage

```bash
docker compose ps                  # anything not "healthy"?
curl -s localhost:8000/health      # API alive?
curl -s localhost:8080 >/dev/null  # web alive?
```

| What you see | Go to |
|---|---|
| A container is unhealthy or missing | §1 |
| Screens load but no plates appear | §2 |
| A camera shows "Cannot play this stream" | §3 |
| The alert never fires | §4 |
| The map is blank | §5 |
| A screen is blank or 401s | §6 |
| Nothing works and time is up | §7 |

---

## 1. A container is down

```bash
docker compose up -d                       # brings back anything stopped
docker compose logs --tail 30 <service>    # if it keeps dying
```

**Postgres unhealthy** — everything depends on it:
```bash
docker compose restart postgres api ingest
```
The API waits for the DB, so restart both.

**Out of memory** (Docker Desktop under 8 GB) — drop the heavy optional
services; nothing in the demo path needs them:
```bash
docker compose stop opensearch minio
```

**Total reset — two minutes, and it works — but only between sessions:**
```bash
make down && make demo
```
It restarts the workers, so expect the grid to refuse our login for 2–15
minutes afterwards (§2a). CAM-DEMO works throughout.

---

## 2. No plates are appearing

This is the most likely failure and it is almost always the worker.

There are three workers (`make ai-multi`); each owns a third of the cameras.

```bash
for w in contrail-ai-worker contrail-ai-worker-2 contrail-ai-worker-3; do docker logs $w --tail 3; done
```

| Log says | Do |
|---|---|
| `analysing N of M camera(s): …` | It is working. Give it 60 s — the clip loops |
| `refused our login; no camera on … will be opened for Ns` | **Nothing.** §2a |
| `no cameras assigned` | The roster is empty. §2b |
| Nothing / container missing | `make ai-multi` |

Plates are read continuously on **CAM-DEMO-01, SBX-cam10, SBX-cam21 and
SBX-cam22** (`AI_WORKER_ALWAYS_ON` in `.env`). Any other camera is analysed
only while it is open on **Live** (`/anpr`) — it starts within about 3 seconds
of opening it. A grid camera with no boxes that is *not* open there is working
as intended.

**Do not restart the workers to "fix" something.** Every restart reopens grid
sessions, and on 11 Oct the grid refused our login after every restart.
Restart only a container that is missing or has crashed.

### 2a. The grid refused our login

Only affects the grid cameras. **CAM-DEMO still works** — demo on that.

The grid refuses our login for a few minutes when sessions come and go — it
happened three times on 11 Oct, each time just after a restart, and lasted
between two and fifteen minutes. The workers handle it themselves: one login
attempt per pause (2, 4, 8, then 15 min), and they resume on their own the
moment it is accepted (`… accepted us again; resuming its cameras`). Anything
you restart makes it worse.

Say: *"The organisers' grid is rate-limiting our account after a reconnect.
We back off and retry once every few minutes rather than hammering it — it
comes back by itself."*

Only if it is still refusing after 20 minutes: check `SANDBOX_RTSP_USERNAME` /
`SANDBOX_RTSP_PASSWORD` in `.env` against the portal, then call the
organisers' helpdesk (+91 95370 89982).

### 2a-bis. Take the grid out of the demo entirely

Every grid camera has a 60-second recording of its own feed in `data/videos`
(`grid-SBX-camNN.mp4`, made by `make grid-record` on 13 Oct). `make grid-replay`
plays each camera from its recording — same code, name, position and history,
labelled "Recorded clip" in the UI and kept out of Insights. `make grid-live`
puts them back on the grid. Neither restarts anything.

Say: *"These are recordings of the organisers' cameras, replayed through the
same gateway and pipeline, because the venue network cannot carry thirty live
feeds. `make grid-live` switches them back."*

### 2b. The roster is empty

The API publishes it every 30 s. If the API restarted recently, wait 30 s.
```bash
docker compose exec redis redis-cli GET nagarnetra:fleet:anpr | head -c 200
```
Empty? Restart the API and wait: `docker compose restart api`

---

## 3. A camera will not play

**Check which camera.** `CAM-DEMO` failing and a grid camera failing are
different problems.

### CAM-DEMO black or erroring
```bash
docker compose restart simulator && sleep 15
curl -s localhost:9100/streams | grep CAM-DEMO
```
If the clip is missing entirely: `ls -la data/videos/anpr_demo.mp4` → if absent,
`make videos` (needs a network).

### A grid camera (SBX-*) will not play
**This is expected sometimes and is not your bug.** Their gateway goes down.

Say: *"That's a federated camera — the department's own gateway is not
responding right now. The registry still lists it, which is the correct
behaviour: unreachable is a problem, not an absence."*

Then click **CAM-DEMO** and carry on. **Do not debug this on stage.**

---

## 4. The alert never fires

The vehicle has to pass the camera *again*. CAM-DEMO's clip loops every 15 s,
so a plate already being read usually comes round within a minute (one measured
run on 12 Oct: 7 s). Fill the time with **Investigate**; do not stand and wait.

Check the **Alarms** queue itself before anything else: watchlist hits sort
first, so the alarm is at the top if it fired. A *Possible watchlist match* at
medium is a one-character near read of the plate — by design, a lead and not a
hit; the exact read raises its own alarm at the entry's priority.

If it still has not fired after two minutes:

```bash
# Is the plate actually being read?
docker compose exec postgres psql -U nagarnetra -d nagarnetra -c \
  "SELECT plate_normalised, ts FROM detections WHERE ts > now() - interval '3 min' \
   AND plate_normalised <> '' ORDER BY ts DESC LIMIT 5;"
```

**Add a plate you can see in that list**, not one you remember. The reading has
to match exactly.

**The terminal fallback — this always works and is genuinely impressive:**
```bash
docker compose exec -e NAGARNETRA_API_URL=http://api:8000 api \
    python /app/scripts/demo_anpr.py
```
It picks the plate CAM-DEMO is reading best (or pass `--plate`), then prints
every step: what the AI read, the watchlist entry, the wait, then the alert
with its evidence. It leaves its entry active and its alarm open — **Retire**
the entry on the Watchlist and close the alarm (`c`) afterwards.

---

## 5. The map is blank

On **Network → Map**, click **Offline** on the basemap toggle. District
boundaries are committed GeoJSON and need no network — this is the "works on a
plane" claim, so demonstrating it deliberately turns a failure into a feature.
**Command**'s map uses no tiles at all, so a blank Command map is not the
network.

Five grid cameras have no position and are never drawn — Command's legend links
to them ("5 cameras without a position"), the Map lists them apart, and Live's
rail has a "Position unknown" filter. That is not a blank map.

If there are no markers at all, the seed did not run:
```bash
docker compose exec api python -m scripts.seed
```

---

## 6. A screen is blank, or everything 401s

Your token expired (15 minutes). **Sign out and back in.**

If a screen is blank with no error, hard-refresh: `Cmd+Shift+R`.

If a role is missing workspaces — that is **correct**. `analyst` and `auditor`
do not see **Live**, and `auditor` does not see **Investigate**. Sign in as
`admin`.

---

## 7. Nothing works — the fallback

**Play the rendered video.** It is real output from this pipeline: plate crops
magnified, transcriptions overlaid, vehicle boxes tracked.

```bash
open ai-lab/runs/*__demo/annotated.mp4
```

Narrate over it: *"This is our pipeline reading a real traffic clip. Each box is
a tracked vehicle, the inset is the magnified plate crop, and the text above it
is the consensus reading across every frame that vehicle was visible."*

Then show the **documents** — `docs/HLD.md` §6 has every measured number, and
`docs/BRIEFING.md` has the architecture. A judge who cannot see the system
running can still assess the engineering.

---

## 8. Answers to give while you fix

| Situation | What to say |
|---|---|
| Grid camera down | *"Federated camera, their gateway. The registry still lists it — unreachable is a problem, not an absence."* |
| No plates on a grid camera | *"Night junction overview with headlight glare. Detection and tracking work; ANPR needs a camera down a lane. Same pipeline, different angle."* |
| Something is slow | *"CPU-only on a laptop, 4.4 fps per stream measured. Production runs this at the edge with a GPU."* |
| A number looks small | *"That's the measured figure, not a projected one. `docs/HLD.md` labels every number measured, arithmetic or extrapolated."* |
| A "Journey to explain" is on screen | *"A route that differs from what the fleet usually does. It is for a person to explain — the system never calls a vehicle suspicious, and it sits below every watchlist alarm."* |
| Insights says "road figures from the latest 20,000" | *"The road-state panels read the latest 20,000 vehicles of the window; the total beside it is the full count. It says so rather than pretending."* |

---

## 9. Before you start — the two-minute check

Run this **at least 20 minutes before** the judges arrive, not while they
watch:

```bash
make demo        # brings everything up and verifies it
```

It reports every step and tells you what is wrong. If it ends with
**"Demo ready"** and no warnings, you are fine. The 20 minutes are for the
grid: it has refused our login for up to fifteen minutes after the workers
connect (§2a), and that should be over before anyone is watching. After that,
**leave the stack running** — no restarts between sessions.

Then open the browser, sign in, and confirm:

- [ ] The feed pill at the right of the top bar says **Live** (pulsing dot)
- [ ] **Command**: the "Reading now" strip is producing plates
- [ ] **Alarms**: no test alarm left open from a rehearsal
- [ ] The plate you intend to watchlist is **not already on it**

And do not run `make test` once anyone is watching: the end-to-end suite raises
a real critical alarm on the live screens before it closes it again.
