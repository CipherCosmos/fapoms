# Deploy FAPOMS to AWS

A complete, copy-paste deployment of the **entire** FAPOMS platform to a single
AWS account. It works on *any* account — the template builds its own VPC and
names the S3 bucket per-account, so there are no collisions and no shared state.

Two modes, chosen with one argument:

| Mode | What runs | Instance | Rough cost/mo\* |
|---|---|---|---|
| **`saving`** (default) | Full app; map engines external/off; no virus scan | `t4g.large` | ~$45–65 |
| **`full`** | Everything above **+ self-hosted OSM (Nominatim + OSRM) + ClamAV** | `t4g.xlarge` | ~$95–130 |

\* Estimates, on-demand, ap-south-1. A 1-year Savings Plan takes ~30% off compute (see *Cost*).

> **Money starts only when you run the deploy command.** Reading and editing these
> files costs nothing.

---

## Every service, and where it runs

Taken from the codebase (`docker-compose.prod.yml`, `.env.docker`, and every
`process.env.*` the backend and mobile app read) — nothing is left out.

| Service | Purpose | `saving` | `full` | You provide |
|---|---|---|---|---|
| PostgreSQL + PostGIS | System of record (spatial) | on-box | on-box | — |
| Redis | Queues, cache, rate limits | on-box | on-box | — |
| Backend (NestJS) | API + realtime + workers + scanner | on-box | on-box | — |
| Frontend (React) | Web app | on-box | on-box | — |
| Caddy | Reverse proxy / TLS | on-box | on-box | — |
| LiveKit | Voice calls (WebRTC) | on-box | on-box | — |
| **Object storage** | Documents, attachments, PDFs, APK | **Amazon S3** | **Amazon S3** | — (created by the stack) |
| **ClamAV** | Upload virus scanning | off | **on-box** | — |
| **Nominatim** | Geocoding (India OSM) | external / off | **on-box** | — (auto-imports) |
| **OSRM** | Road routing (India OSM) | external / off | **on-box** | — (auto-prepared) |
| Email | Digests, decision events | — | — | **SES or Gmail** |
| Push (Firebase FCM) | Mobile/web notifications | — | — | **your Firebase project** |
| Google Maps | Mobile map + geocoding fallback | — | — | **your API key** |
| OSM tiles | Web map basemap | public tiles | public tiles | — (self-hosting tiles is out of scope) |
| Mobile app | Field APK | build with EAS, host `.apk` in S3 | same | **rebuild with your API URL** |

---

## Prerequisites (each deployer, once)

1. An **AWS account** with permission to create resources (an IAM admin user or SSO — **not** the root user).
2. **AWS CLI v2** installed, with credentials for your account configured
   (`aws configure`, `aws configure sso`, or exported keys). Check: `aws sts get-caller-identity`.
3. Access to **this repository** (to get the code onto the box).

> The `agent-toolkit` / `aws login` steps from the AI-assistant setup are **not**
> needed to deploy — ignore them here.

## What you must provide (external accounts/keys)

These are per-environment and can't be baked into the code. `bootstrap.sh` writes
a clearly-marked block in `.env.docker` for you to fill:

- **Google Maps API key** — a key from *your* Google Cloud project (Maps SDK + Geocoding).
- **Firebase (FCM)** — *your* Firebase project's service-account JSON (for push).
- **Email** — either **Amazon SES** (verify a sender/domain in your account) or a **Gmail app password**.
- *(optional)* a **domain** — without one you run on the public IP over HTTP; add a domain later for HTTPS.

---

## 1. Deploy the infrastructure — one command

```bash
export ALERT_EMAIL="you@example.com"     # budget alerts
export AWS_PROFILE="your-profile"        # omit to use default credentials
export AWS_REGION="ap-south-1"           # your region

./deploy/aws/deploy.sh saving            # minimal — or:  ./deploy/aws/deploy.sh full
```

Add `--preview` (e.g. `./deploy/aws/deploy.sh saving --preview`) to get a change
set to review before anything is built. The script prints the outputs you need:
**PublicIp**, **S3Bucket**, **ConnectCommand**.

## 2. Bring the app up on the box

1. **Connect** (SSM — no SSH key, no open port):
   ```bash
   aws ssm start-session --target <InstanceId> --region <your-region>
   ```
2. **Get the code onto the box** — clone with a token (private repo) or copy it up:
   ```bash
   sudo -i
   export GIT_URL="https://<PAT>@github.com/<you>/gssAutomation.git"
   ```
3. **Run bootstrap in the SAME mode you deployed:**
   ```bash
   export PUBLIC_IP=<Elastic IP>  S3_BUCKET=<bucket>  AWS_REGION=<your-region>  MODE=saving   # or full
   bash /opt/fapoms/deploy/aws/bootstrap.sh
   ```
   It writes a **complete** `.env.docker` (all secrets generated; S3 via the
   instance role — no keys on the box), configures LiveKit for the public IP,
   removes MinIO, and — in `full` mode — prepares OSRM and starts ClamAV +
   Nominatim + OSRM. It then prints exactly what's left to do.
4. **Fill the external values** in `.env.docker` (Google Maps, Firebase, email),
   then re-run the `docker compose ... up -d` line the script printed.
5. **Load data** — restore a dump or seed a fresh DB:
   ```bash
   deploy/restore.sh fapoms.dump
   # or, fresh:
   docker compose -f deploy/docker-compose.aws.yml exec backend npm run --workspace=packages/backend seed
   ```
6. **Verify** — `curl -s http://localhost:8080/api/v1/health`, then open `http://<PublicIp>`.
7. **Mobile** — rebuild the APK with `EXPO_PUBLIC_API_URL=http://<PublicIp>/api/v1`, upload the `.apk` to the bucket.

---

## Per-service notes

- **S3** — private, encrypted, lifecycle-managed. The instance's IAM role grants
  access to just this bucket; nothing carries access keys. Migrate existing files
  from a MinIO box with `mc mirror old-minio/fapoms-documents s3/<bucket>`.
- **LiveKit** — needs the public IP for WebRTC media; bootstrap sets
  `use_external_ip: true` and the TURN/media ports are already open in the stack.
- **ClamAV** (`full`) — signatures download on first start (a few minutes);
  `FILE_SCAN_REQUIRED=true` makes the backend refuse un-scannable uploads.
- **Nominatim** (`full`) — imports the India extract on first start; this runs for
  **hours** and the container is unhealthy until done, then serves. Routing (OSRM)
  is ready as soon as bootstrap finishes its one-time graph prep.
- **Email** — SES is cheapest; verify a sender identity and leave the SES sandbox,
  or use a Gmail app password. Fill one set in `.env.docker`.
- **Push / Maps** — your Firebase project and Google Maps key; both are free-tier
  for typical volumes.
- **Tiles** — the web map uses public OpenStreetMap tiles. Self-hosting a tile
  server is a separate, heavy project and is intentionally not included.

---

## Cost

Estimates, ap-south-1, current scale — **verify in the Pricing Calculator**:

| | `saving` | `full` |
|---|--:|--:|
| EC2 (t4g.large / t4g.xlarge) | ~$49 | ~$98 |
| EBS gp3 (60 / 250 GB) | ~$6 | ~$24 |
| S3 + email + DNS + snapshots + transfer | ~$5–10 | ~$5–10 |
| **On-demand total** | **~$60–65** | **~$127–132** |
| **With 1-yr Compute Savings Plan** | **~$41–46** | **~$95–100** |

### Buy the Savings Plan *after* a baseline — not at launch

A Savings Plan is a **1-year commitment you pay for whether you use it or not**,
so buying on day one means guessing and usually over-committing. Instead: run
on-demand **1–2 weeks**, then **Cost Explorer → Savings Plans → Recommendations**,
and buy a **1-year, No-upfront Compute Savings Plan** (~30% off, flat cash flow)
at the level AWS computes from your real usage. Each account does this on its own
data. The stack's budget alarm emails you at 80% / 100% meanwhile; also enable
**Cost Anomaly Detection** (free).

---

## Tear it all down

```bash
aws cloudformation delete-stack --stack-name fapoms --region <your-region>
```

The **S3 bucket is retained on purpose** (it holds documents) — empty and delete
it by hand when you're sure. Everything else, including the instance and Elastic
IP, is removed and billing stops.
