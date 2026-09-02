# Reading service logs from the app

`/admin/logs` shows the live and historical output of every container in the deployment, to
administrators, in the browser. There is a matching HTTP endpoint so the same logs can be pulled
from a terminal and pasted into a conversation.

It exists because on at least one deployment the machine is administered by someone else. Every
question ending in "what did the backend actually say when that failed?" otherwise costs a message
to a third party and a wait long enough that the question stops being asked.

## Using it

**In the app** — Administration → Service Logs. Pick a service, choose a range, optionally search,
and either read the history or press **Follow live**. Copy and Download take what is on screen.

**From a terminal** — the token goes in a header, never the URL:

```bash
export FAPOMS_TOKEN='...'   # localStorage.fapoms_token, after signing in
curl -sS -H "Authorization: Bearer $FAPOMS_TOKEN" \
  "https://your-host/api/v1/admin/logs/backend?tail=200&since=1h&format=text"
```

| Parameter | Meaning |
|---|---|
| `tail` | Lines to return. Default 500, ceiling 20000. |
| `since` / `until` | ISO-8601, or relative: `15m`, `2h`, `3d`. |
| `q` | Case-insensitive substring, applied **server-side** across the whole range. |
| `format` | `json` (default) or `text`. |
| `download=1` | With `format=text`, sends a `Content-Disposition` filename. |

`GET /api/v1/admin/logs/services` lists what this deployment runs.
`GET /api/v1/admin/logs/{service}/stream` is the live feed, as server-sent events.

Searching is server-side on purpose. Filtering the loaded window in the browser would be simpler
and would answer the wrong question: the line you are hunting is almost never in the last 500, and
a client-side filter would return nothing while giving no hint that the match was just outside the
window.

## How it reaches the logs, and why it is built this way

The backend has **no access to the Docker socket**, and that is deliberate. `/var/run/docker.sock`
is root on the host with extra steps: whatever holds it can start a privileged container and mount
the host filesystem. The backend parses uploaded spreadsheets and renders PDFs, so it is precisely
the process that should not hold it — a remote-code-execution bug there would otherwise escalate
straight to the machine storing the audit record.

Instead the socket is mounted **read-only into a separate proxy container**
(`tecnativa/docker-socket-proxy`), configured to permit `GET /containers` and refuse everything
else, including every `POST`. It publishes no ports, so it is reachable only from the compose
network. The backend talks HTTP to it.

```
browser ──▶ backend ──▶ dockerproxy (GET /containers only) ──▶ /var/run/docker.sock (ro)
```

The worst case if the backend is compromised becomes "an attacker can read logs" — bad, but bounded,
and a strictly smaller set of powers than the backend already holds over its own data.

### The other controls

- **Role, not permission.** `@Roles(SystemRole.ADMIN)` on the controller and `/admin/logs` in
  `route-permissions.ts`. Gated on the role itself rather than a grantable permission because logs
  are the least filtered view of the system there is; that should not be addable to a role by
  editing a role.
- **Allowlist.** A request names a *service* from `LOG_SERVICES`, never a container id, and the
  match is additionally scoped to this compose project — so on a daemon hosting more than one
  stack, `postgres` cannot resolve to somebody else's.
- **Redaction.** Bearer tokens, JWTs, connection-string passwords, `*_PASSWORD`/`*_SECRET`/
  `*_KEY` assignments, AWS key ids and PEM private-key bodies are masked server-side before
  anything leaves the box. Not a permission boundary — an administrator can already read the
  configured secrets — but a blast-radius one, because the entire purpose of this feature is that
  its output gets pasted somewhere else.
- **Audited.** Every read and every stream is written to the audit trail with the service, the
  query and the caller. A feature that shows one person everything the platform did should record
  who looked.
- **Throttled.** 60 history reads and 10 stream opens per minute.
- **Bounded.** Two independent response ceilings (line count and bytes), because one line can be a
  megabyte of stack trace. Live streams close themselves after 30 minutes so a forgotten tab does
  not pin a connection to the proxy indefinitely.

## Limits worth knowing

**Logs do not survive their container being replaced.** A deploy recreates the backend and its
predecessor's output goes with it. The screen says so rather than presenting an empty window as
though nothing happened. If you need history that outlives deploys, that needs a log collector
writing to a volume — a separate piece of work, not this one.

**Retention is Docker's, and on the dev stack it is unbounded.** No `logging:` block is set, so
json-file keeps everything since the container started and the file grows without limit. That is
what makes "track back in time" work, and it is also a disk-usage risk on a long-lived container.
Adding rotation would cap the disk and shorten the history; the trade is deliberate and unmade.

**Turning it off**: `SERVICE_LOGS_ENABLED=false` makes every route return 503. Removing the
`dockerproxy` service has the same practical effect, and the UI reports it rather than erroring.

## If the page says no services are readable

1. Is the proxy up? `docker compose ps dockerproxy`
2. Can the backend see it? `docker compose exec backend wget -qO- http://dockerproxy:2375/containers/json | head -c 200`
3. On rootless podman the socket is elsewhere — enable `podman.socket` and set
   `DOCKER_SOCKET_PATH=/run/user/$(id -u)/podman/podman.sock`.
