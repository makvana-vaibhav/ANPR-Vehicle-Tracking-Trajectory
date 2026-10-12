# Security

NagarNetra processes vehicle movements across a state. That makes it a
surveillance system, and the controls that matter are not only the ones that
keep attackers out — they are the ones that make misuse by authorised users
visible.

This document says what is **implemented and verifiable today**, and, in its own
section, what is **not**. The distinction is load-bearing: a security document
that describes intentions as though they were controls is worse than no
document, because it stops anyone looking.

---

## 1. What is enforced today

| Control | State | Where |
|---|---|---|
| Password hashing (argon2id) | ✅ | `app/core/security.py` |
| JWT access + refresh, rotation, revocation | ✅ | `app/routers/auth.py`, `app/services/token_store.py` |
| Role-based access, 6 roles × 23 permissions | ✅ | `app/core/rbac.py` |
| Persons watchlist: four-eyes enrolment, private face media, every view audited | ✅ | §7.1, `app/routers/persons.py` |
| Audit trail on every mutation and every search | ✅ | `app/middleware/audit.py`, `app/services/audit.py` |
| Audit trail readable, and reading it is audited | ✅ | `app/routers/audit.py` |
| Password policy beyond length | ✅ | `app/core/password_policy.py` |
| Forced password change on an admin-set credential | ✅ | migration `0002` |
| Rate limiting, per-deployment | ✅ | `app/core/ratelimit.py` |
| Retention enforcement (actual deletion) | ✅ | `app/services/retention.py` |
| Secrets kept out of git | ✅ | `.env.example` committed, `.env` ignored |
| Security headers + CSP | ✅ | `web/nginx/contrail-app.conf` (both servers) |
| Scrape endpoint carries no personal data | ✅ | `app/routers/health.py` |
| **TLS** | 🟡 the web tier serves HTTPS on :8443 (HSTS for real hostnames); :8080, the API's :8000 and container-to-container traffic are plain HTTP | §6.1, §8 |
| **Encryption at rest — application level** | ✅ | AES-256-GCM, `app/core/crypto.py`; sealed `enc://` credentials, 44 tests |
| **Encryption at rest — volumes / objects** | ❌ **not implemented** | see §8 |
| **Backups / DR** | 🟡 manual backups, verified by restore; no schedule, no off-site copy, no DR | `scripts/backup.sh`, [INFRASTRUCTURE §8.4](INFRASTRUCTURE.md#84-backups) |

---

## 2. Identity and access

### Roles

Six roles, defined once in `app/core/rbac.py` and enforced by a dependency on
every route. The matrix is the single source of truth; the frontend reads the
caller's permissions and hides what they cannot use, but **the frontend is not
a control** — every one of these is checked server-side on every request.

| Role | Holds | Notably cannot |
|---|---|---|
| `admin` | every permission | — |
| `supervisor` | camera RW, watchlist RW, persons enrol/approve/retire, full alert lifecycle, streams, search, audit read | manage accounts; approve a person they enrolled |
| `operator` | camera read, streams, watchlist read, persons read, alert read + **acknowledge**, search | dispatch or close an alert; change either watchlist |
| `analyst` | camera read, watchlist read, persons read, alert read, search | view streams; change anything |
| `auditor` | camera read, watchlist read, persons read, alert read, **audit read** | view streams; run vehicle searches; change anything |
| `api_client` | camera create only | everything else |

Two deliberate splits:

* **Alert transitions are separate grants.** Acknowledging is routine,
  dispatching commits a unit, closing ends the record. In a control room these
  are different authorities, so they are different permissions.
* **An auditor cannot run a vehicle search.** Reading the record of who traced
  whom is a different job from tracing people, and combining them would remove
  the point of having an auditor.

### Accounts

* **No self-service registration.** Every account is created by an
  administrator and belongs to a named officer. An account nobody vouched for
  makes the audit trail unattributable at the root.
* **An administrator cannot deactivate or demote themselves.** The last admin
  to do so locks everybody out permanently.
* **Accounts are deactivated, not deleted.** Deleting a user who has acted
  orphans every audit row naming them; the API refuses it once an account has
  any history.
* **`must_change_password`.** A password an administrator chose is a shared
  secret. Until the holder replaces it, at least two people can sign in as
  them and nothing that account does is attributable to one person. Accounts in
  that state are flagged in the UI.

### Password policy

`app/core/password_policy.py`. Length alone admitted `NagarNetra@2026` — this
repository's own documented demo credential, published in `scripts/seed.py`.
Enforced:

* minimum 12 characters;
* not a credential documented in this repository;
* does not contain the username;
* not a single repeated character, keyboard run, or digit run;
* at least 6 distinct characters.

Deliberately **not** enforced: symbol/case/digit composition rules. They push
people toward `Password1!` and a sticky note; NIST moved away from them for
that reason.

### Tokens

Access tokens are short-lived (15 min) with 7-day refresh and rotation on use.
Logout revokes the refresh token in Redis, and revocation is checked on the
WebSocket handshake as well as on HTTP — a logged-out operator whose access
token has not yet expired must not keep receiving the live feed, and the feed
is long-lived enough for that gap to matter.

---

## 3. The audit trail

**Every mutating request, every search, every stream open and every
authentication event writes an `audit_log` row.** Middleware covers the general
case; plate searches, stream opens and watchlist mutations also make explicit
calls carrying their parameters.

Each row records: timestamp, user id, username, role, action, resource type and
id, source IP, user agent, scrubbed parameters, and the result
(`success` / `denied` / `failure`).

Three properties worth stating:

1. **Denied attempts are recorded.** What somebody *tried* to do is as
   interesting as what they managed.
2. **Reading the audit log is itself audited.** A reviewer who leaves no trace
   is a hole in the control. There is no role that reads the trail unseen —
   including `admin`.
3. **The username is stored alongside the user id**, so history survives an
   account being removed. Usernames are immutable for the same reason:
   renaming would silently rewrite what the log appears to say about the past.

The trail is readable at `GET /api/v1/audit` (permission `audit.read`) with
filters by action prefix, user, result and time window, and exportable as CSV.

---

## 4. Data retention

Configured in `Settings`, **enforced daily** by `app/services/retention.py`.

| Data | Retained | Mechanism |
|---|---|---|
| Detections | 365 days | TimescaleDB `drop_chunks` |
| Camera health | 90 days | TimescaleDB `drop_chunks` |
| Plate and vehicle crops | 90 days (`RETENTION_MEDIA_DAYS`) | deleted from object storage by the daily sweep, a day partition at a time (`retention.expire_crops`); a crop an open alert still points at is kept until the alert is closed, so the policy never deletes the evidence an officer is acting on |
| Audit log | 1825 days (5 years) | predicate delete |
| Face embedding of a persons-watchlist entry | while the entry can match | nulled on rejection, retirement or expiry (`app/services/persons.py`) |
| Reference photo of a retired or rejected entry; face crop on a person-match alarm | 90 days (`RETENTION_PERSON_MEDIA_DAYS`) | deleted from object storage by the persons sweeper, hourly |

Under the DPDP Act the stated period is the lawful basis for holding the data
at all, so these are not advisory. A policy nobody enforces is worse than no
policy, because it is documented as a control that does not exist — which is
precisely what this was until it was implemented.

**The audit log outlives everything it describes.** It is the record of who
looked at whom, which is exactly what an inquiry into misuse would need, and it
must not expire on the same schedule as the data it describes.

**Alerts outlive the detections that raised them.** An alert is a police record
with an operator's name against each transition; the raw sighting is evidence
with a shorter lawful life. `Alert.detection_id` therefore dangles by design
once the detection expires, and `retention.evidence_expired()` exists so a
screen can say "the evidence has passed its retention date" rather than showing
a lookup failure that looks like a bug.

`RETENTION_ENFORCE=false` disables deletion for a deployment with an external
purge process. The sweep still runs and reports what it *would* have deleted,
so the gap between policy and practice stays visible rather than silent.

---

## 5. Rate limiting

Counted in Redis, so the budget is per-deployment rather than per-replica — a
limit that grows when you add capacity is not a limit.

| Scope | Budget |
|---|---|
| General API | 300 requests / 60 s |
| Authentication | **10 failures** / 300 s |
| `/health`, `/ready` | exempt |

**Authentication counts failures, not attempts.** The first implementation
counted every attempt and was wrong: a control room sits behind one NAT, so
unauthenticated callers share an address key, and ten officers signing in at
shift change would lock each other out. What is being limited is guessing, and
guessing is failure by definition.

Health probes are exempt because a throttled healthcheck reports the service
unhealthy and restarts it, turning a rate limit into an outage.

The limiter **fails open** if Redis is unreachable, and logs when it does. A
control room locked out of its alert screen because a cache is down is the
worse failure.

---

## 6. Network and browser

* One origin. The browser talks to nginx, which proxies `/api/` and `/ws/` to
  the API; no cross-origin requests, so no permissive CORS is needed.
* Content-Security-Policy, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy` set in `web/nginx/contrail-app.conf` and asserted by
  `tests/e2e/test_web_headers.py`.
* Tokens live in `sessionStorage`, not `localStorage`: an operator's
  credentials should not outlive the browser session on a shared control-room
  workstation.
* `X-Forwarded-For` is believed **only from the web tier's nginx**, whose
  address is pinned (`FORWARDED_ALLOW_IPS`); any other caller is identified by
  its socket peer, so a forged header changes neither the rate limiter's key nor
  the audit trail's client address (§8, S11; `tests/test_client_address.py`).
* `GET /metrics` is **unauthenticated and exempt from rate limiting**, and
  deliberately so: a scraper that needs a token is a scraper that stops working
  when the token expires, and a throttled probe reports the service unhealthy.
  It carries aggregate counters only — no plate, no camera, no user. It does
  reveal *volume*, which is not nothing in a surveillance system, so a
  deployment exposing it beyond the internal network should restrict it at the
  ingress rather than behind application auth. `GET /metrics/prometheus`, the same
  picture for Prometheus, follows the same rules; its labels are route *templates*,
  camera codes and worker ids — never a plate, a person or a user. Prometheus and
  Grafana (`make monitoring`) listen on 127.0.0.1 only.

### 6.1 TLS

The web container serves the same application twice: plain HTTP on :8080, which
the demo uses, and **HTTPS on :8443** (`web/nginx.conf`).

* **Certificate.** `cert.pem` and `key.pem` mounted in `infra/tls/` are used as-is —
  for a browser that trusts it, make them with mkcert
  (`mkcert -install && mkcert -cert-file infra/tls/cert.pem -key-file infra/tls/key.pem localhost 127.0.0.1 ::1`,
  then `docker compose up -d --no-deps web`). With nothing mounted, the container
  generates a self-signed RSA-2048 certificate at start
  (`web/docker/30-contrail-tls.sh`), valid 397 days for `localhost`, `127.0.0.1`,
  `::1` and `TLS_SERVER_NAMES` / `TLS_SERVER_IPS`, writes it to `infra/tls/` and reuses
  it after; the browser warns once. The key is checked against the certificate
  before nginx starts. `infra/tls/*` is gitignored. TLS 1.2 and 1.3 only.
* **Nothing on the HTTPS page is fetched over HTTP.** The bundle's API base
  (`http://localhost:8000` in the demo) gives way to the page's own origin on an
  `https:` page (`web/src/lib/apiBase.ts`), so API calls and the live feed go through
  nginx (`wss://…/ws/events`). For requests that arrive over TLS the API returns
  plate crops and face media under `/media/` and our gateway's WHEP and HLS under
  `/gateway/` on the same origin (`app/core/public_origin.py`); nginx proxies them.
  Over HTTP every URL is exactly what it was. MEASURED in Chrome on :8443 with the
  CSP enforced: WebRTC through the proxied WHEP, 12 of 12 crops loaded, no request
  over plain HTTP, no console error.
* **The proxies are read-only.** `/media/` passes GET only, path and query byte for
  byte, to the host the URL was signed for; a PUT is refused (403). `/gateway/webrtc/`
  passes only a POST to `<path>/whep`, and MediaMTX itself now asks the API about
  every publish and read (§8, S3): only the simulator's identity may publish, so
  WHIP through the proxy is refused twice over. Both are asserted by
  `tests/e2e/test_web_tls.py` and `tests/test_gateway_auth.py`.
* **HSTS** is sent on the HTTPS server only, and only for real hostnames. HSTS is per
  host, not per port: sent for `localhost` it would upgrade the demo's own
  `http://localhost:8080` to HTTPS and break it.
* Not covered: the :8080 demo and traffic between containers are still plain
  HTTP. Since 12 Oct the API, MinIO and MediaMTX ports listen on `127.0.0.1`
  only, so that cleartext no longer crosses the venue network (§8, S2, S4).

### Federated sources

The platform **consumes** the organisers' grid and never publishes to it, per
their integration guide.

The grid requires credentials, and they are held **server-side only**:

* `SANDBOX_RTSP_USERNAME` / `_PASSWORD` live in `.env`, which is gitignored.
* RTSP carries them in the URL — the protocol offers nowhere else — so every
  log line that prints a stream source redacts them, enforced by a test that
  greps for an unredacted one.
* The stream grant returned to a browser has them stripped
  (`app/core/urls.py`). A browser cannot play RTSP, and returning the field
  verbatim would have undone the proxy below.
* The CDN's HLS is behind a login session that the API holds and the browser
  never sees. `app/routers/grid_media.py` proxies media, authorised by the
  same short-lived, camera-scoped stream token used for every other feed.

`VmsInstance.credentials_ref` holds a *pointer* into a secret store, never a
secret — asserted by a test.

---

## 7. Lawful use

Technical controls do not make surveillance lawful. What the platform provides
toward that:

* **Purpose limitation is visible.** A watchlist entry carries a category and a
  case reference, and both travel into the alert. An entry with no case
  reference is a question waiting to be asked.
* **Every trace is attributable.** Reconstructing a vehicle's movements is the
  most privacy-sensitive read available and is audited explicitly, with the
  plate and window recorded.
* **Retention is enforced, not merely stated** (§4).
* **Uncertainty is shown, not hidden.** Route legs the correlator cannot
  believe are flagged rather than dropped; near-match watchlist hits are capped
  at medium priority and labelled `possible_match`. A system that presents
  inference as fact invites decisions its evidence does not support.

Not addressed here and needing legal rather than engineering input: the lawful
basis for deployment, DPIA, the notification regime, and who may authorise a
watchlist entry.

### 7.1 The persons watchlist — purpose limitation, and what is never stored

Face matching against a list of people is the most privacy-sensitive thing
this platform does. It was built only with these controls, each enforced in
code and covered by tests (`services/api/tests/test_persons.py`,
`ai-lab/tests/test_face.py`, `services/ai-worker/tests/test_persons_edge.py`):

**Who decides.**

* **Four-eyes.** An entry is enrolled (`person.enrol`) by one account and
  matched only after a *different* account approves it (`person.approve`). The
  API refuses self-approval and self-rejection, audits the attempt as denied,
  and CHECK constraints in migration `0009` refuse it again at the database.
* **Purpose and expiry.** Every entry carries a category (`missing`, `wanted`
  under a named warrant, or `demo` — a fictional case on recorded footage), a
  case reference and a written purpose and legal basis, all required. It
  lapses at `valid_until`: 30 days by default, never more than 90; the platform
  retires it on the minute and audits that as `person.expire`. Renewal is a new
  enrolment and a new approval.
* **A person confirms every match.** A match is raised as a *Possible person
  match*, priority `high` and never `critical`, with its reasons — similarity
  against the threshold, frames that agreed, the margin over the next-closest
  entry, what the entry is held for. The alarm screen shows the enrolled face
  and the captured face side by side under "A person must confirm this match
  before anyone acts". Nothing is dispatched automatically.

**Where it runs.** Only on cameras the registry tags `analytics:faces` — never
on the grid's junction cameras by default — and only while an approved entry
exists: with an empty gallery the face stage does not even look.

**What is never stored.**

* **Faces that matched nothing.** At the edge, a face's embedding exists for
  one comparison and is discarded (`ailab/face/stage.py`); the multi-frame
  logic is handed the comparison result, never the embedding. A crop is taken
  only of a frame that passed the threshold, held in memory only while that
  face is in view, and uploaded only if several frames agreed. No log line,
  event or file records a face that matched nothing.
* **Embeddings of a face a camera saw** — not even a matched one. The event
  carries the similarity, never the vector.
* **The uploaded original.** A reference photo is re-encoded from its pixels
  before it is stored: no EXIF, no GPS, no embedded thumbnail. Its header is
  checked before it is decoded, so an upload cannot be a decompression bomb.
* **Embeddings of entries that can no longer match.** Rejection, retirement
  and expiry null the embedding at once; the photo goes at the retention date.

**Who can see a face, and the record of it.**

* Photographs live in a separate bucket (`MINIO_PERSONS_BUCKET`) that is never
  given an anonymous policy — `minio-init` sets it private, and the API refuses
  to store a face if it has acquired one. Plate crops' bucket is unaffected.
* A face is reachable only through a two-minute signed link issued by an
  endpoint that requires `person.read` (all human roles; never `api_client`).
* **Every list, every view and every alarm-evidence read writes an audit row
  naming each photograph it issued a link for** (`person.list`, `person.view`,
  `person.match_view`), as does every enrolment, refusal, approval, rejection
  and retirement.
* The live event feed reaches every signed-in role, so raw `person.match`
  events are never fanned out to it (`event_tailer.PRIVATE_EVENTS`); the alarm
  that is carries no name and no photograph.
* The gallery the cameras read carries ids, categories, case references and
  embeddings — no photograph, no name — and expires after 15 minutes without a
  refresh, so a worker cut off from the platform stops matching rather than
  matching an outdated list.

**What this does not settle.** The accuracy figures are from three people in
one well-lit stock clip, not real CCTV; the threshold is a starting point to be
re-measured on footage from the cameras it will run on. Who may lawfully
authorise an entry, notification of the people enrolled, and a DPIA need
legal input, as for the plate watchlist.

---

## 8. What is not implemented

Stated plainly, because a security document that omits its gaps is misleading.
The S-numbers are the 12 Oct review's (`docs/review/SENTINEL_JUDGE_REVIEW.md`
§5.2); [HLD §16.7](HLD.md#167-current-prototype-against-production) tracks the
same list.

### 8.1 Closed on 12 Oct — what is true of the running stack now

Each verified against the live stack after the change, not only in tests.

| # | Was | Now | Evidence |
|---|---|---|---|
| S1 | Plate-crop bucket world-readable | Private; presigned links only | `b4df4d1` |
| S2 | Postgres, Redis (no password), MinIO, OpenSearch, MediaMTX API/RTSP/HLS/WHEP and the API on every interface | **Only web :8080 and :8443 listen beyond the laptop.** Every other port is published on `127.0.0.1` (`docker-compose.yml`). Redis requires a password (`requirepass`); every client — API, ingest, the three workers, the simulator, the scale consumers, the native worker — connects with it | From the LAN address, 6379, 5432, 9000, 9001, 9200, 9997, 8554, 8888, 8889, 8000 and 9100 refuse; 8080 and 8443 answer. `redis-cli PING` and `XADD` without the password → `NOAUTH` |
| S3 | Our own cameras (CAM-DEMO-01/02) played without a token; anything on the bridge network could publish | MediaMTX runs `authMethod: http` and asks the API about **every** publish and read (`app/routers/gateway_auth.py`). Publish: the simulator's identity only. Read: the workers' identity, or a browser's camera-scoped, ~2-minute stream token — issued and audited as `camera.view` — on the WHEP/HLS URL, valid only for that camera's path and only over WebRTC/HLS. Nothing else; the API down means new sessions are refused, not let through | Anonymous RTSP, WHEP and HLS reads of CAM-DEMO-01 → 401, direct and via :8443; anonymous publish → refused; a forged token → 401; the grant's own URLs play. `tests/test_gateway_auth.py`, `services/ai-worker/tests/test_gateway_credentials.py` |
| S5 | One shared password, committed in `scripts/seed.py`, for supervisor, operator, analyst and auditor — and the same value for admin and the API client | **Every seeded account has its own generated password** (`BOOTSTRAP_ADMIN_PASSWORD`, `DEMO_PASSWORD_<USERNAME>` in `.env`, written by `make env`), and is flagged `must_change_password`. The login page no longer prefills or prints a password. Seed output names the `.env` key, never the value | All six log in with their own password; `NagarNetra@2026` → 401 for every one |
| S11 | The login limiter and the audit trail took the first `X-Forwarded-For` entry as sent, and uvicorn trusted every peer (`--forwarded-allow-ips "*"`) | Forwarded headers are believed **only from the web tier's nginx** (`FORWARDED_ALLOW_IPS`, pinned to its fixed address); anyone else is their socket peer. Through nginx the client is the right-most address nginx did not vouch for, so a value written in front of it changes nothing | `tests/test_client_address.py`: rotating `X-Forwarded-For` on every wrong password still hits 429, direct and through the proxy |
| — | Development passwords as compose fallbacks; the running stack used the values published in `.env.example` (including the JWT signing key — anyone with the repository could mint an admin token) | **No password in the running stack appears in this repository.** Compose has no fallbacks: an unset secret stops it with `<KEY> is not set - run make env`. `make env` generates every secret per install (`scripts/gen_secrets.py`, prints names only, `.env` mode 0600). The JWT key, Postgres, MinIO root and Grafana admin passwords were rotated on the live stack | `docker compose --env-file .env.example config` fails on the first empty secret |

**Rotating a secret on a running stack** (what `gen_secrets.py --rotate-published`
reports as needing to be applied): Postgres — `ALTER ROLE … PASSWORD` inside the
container *before* recreating its clients, since `POSTGRES_PASSWORD` only applies
to an empty data directory; MinIO, Redis, MediaMTX identities and the JWT key —
`docker compose up -d` (and the AI profiles) recreates every container that reads
them; Grafana — `grafana cli admin reset-admin-password` inside its container; the
seeded accounts — `python -m scripts.seed --only users --reset-demo-passwords`.
Rotating the JWT key signs everyone out.

### 8.2 Still open

| Gap | Consequence | Notes |
|---|---|---|
| **TLS only at the web tier** (S4) | Over :8443 the browser's traffic is encrypted (§6.1). The :8080 demo and every hop between containers — API, Redis, Postgres, MinIO, MediaMTX — are cleartext. The data-tier ports no longer listen beyond the laptop (8.1), so that cleartext no longer crosses the venue network | Production: TLS to the bus, database and object store; only an ingress in front of :8443 published |
| **The internal network is one trust zone** | Any container on the bridge reaches Postgres, Redis and MinIO with the shared service credentials, and the MediaMTX control API (excluded from the auth callback, so the API and the healthcheck do not depend on each other) without any | Per-service identities and network policies (HLD §16.2); MediaMTX API behind its own credential |
| **OpenSearch security plugin off** | No authentication on the index; reachable only from the bridge network and this machine's loopback | Security plugin on, TLS, a service user |
| **One service credential per store** (S7) | Every service uses the one Postgres role and the MinIO root user; presigned URLs carry the root access key id. The MinIO password is no longer public, so those links cannot be forged | A read-only MinIO service account for signing; INSERT-only and read-only Postgres roles per service |
| **`ENVIRONMENT=development`** (S6) | Development behaviour (configuration logging at debug, `/docs` open). Logged configuration now redacts the passwords inside `DATABASE_URL` and `REDIS_URL` | A production profile |
| **Audit log not tamper-evident** (S8) | Someone with database access can rewrite history | INSERT-only grant, hash chain, WORM export (HLD §16.5) |
| **Stream tokens are bearer URLs for their two minutes** | The token rides in the WHEP/HLS query string, so it appears in MediaMTX and proxy request lines and in browser history. It is camera-scoped and dies in ~2 minutes; a session already open outlives it, by design | Short enough that a leaked URL is useless by the time it is read; a production gateway would bind the session to the operator's TLS client |
| **No volume/object encryption at rest** | The database volume and object storage are unencrypted, so anyone with the disk has the plate history | Postgres TDE or encrypted volumes; MinIO SSE. Application-level AES-256-GCM (`app/core/crypto.py`) covers sealed credential values only |
| **Backups are manual and unencrypted** | `make backup` is verified by restore, but nothing runs it on a schedule, nothing copies it off-site, and the directory holds plate histories and faces in clear | Encrypt and copy off-site by the procedure in [INFRASTRUCTURE §8.4](INFRASTRUCTURE.md#84-backups); time a live restore before claiming an RPO/RTO |
| **Plate detector weights are AGPL-3.0** (S9) | Licence obligation on the deployed artifact | Must be replaced or the obligation accepted before shipping |
| **No penetration test** | Unknown unknowns | The 12 Oct review was an internal, anonymous-request probe, not a pen test |

**None of these is hidden anywhere else in this repository.** `docs/BUILD_STATE.md`
carries the same list.

---

## 9. Reporting

This is a hackathon submission, not a deployed service. Security findings
should go to the repository owner. If it were deployed, this section would name
a contact, a disclosure window and a triage commitment — and the absence of
those is itself a gap.
