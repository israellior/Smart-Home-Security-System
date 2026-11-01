<div align="center">

# 🔔 Porchlight

**A Ring-style smart video doorbell, built end to end — from the Raspberry Pi at the door to the phone in your pocket.**

[![Live](https://img.shields.io/badge/live-porchl.stream-2ea44f?style=for-the-badge)](https://porchl.stream)
[![Device repo](https://img.shields.io/badge/device_repo-C%2B%2B%20%C2%B7%20Python-00599C?style=for-the-badge)](https://github.com/israellior/Smart-Home-Security-System-Device)

![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC%20·%20LiveKit-333333?logo=webrtc&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-232F3E?logo=amazonwebservices&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![Terraform](https://img.shields.io/badge/Terraform-7B42BC?logo=terraform&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?logo=githubactions&logoColor=white)

</div>

<p align="center">
  <img src="docs/screenshots/live-view.png" width="28%" alt="Live view" />
  <img src="docs/screenshots/demo.webp" width="28%" alt="Tapping the light, talking, recording, and the recording landing in Activity" />
  <img src="docs/screenshots/activity.png" width="28%" alt="Activity list" />
</p>
<p align="center"><sub>The app's own screens and CSS, shown with sample data. The camera picture is an illustration.</sub></p>

## What it does

Someone rings the doorbell → every phone on that doorbell gets a notification, with the visitor's name if the doorbell knows them → you open the app, watch them live and talk back, from anywhere.

| | |
|---|---|
| 📹 **Live view and two-way talk** | 30 fps video and audio over WebRTC through a LiveKit SFU — many viewers, one upload from the Pi |
| 🔔 **Instant alerts** | Rings and motion as Web Push notifications, on Android and iPhone (installable PWA) |
| 🧍 **Person detection** | On-device TensorFlow Lite model, so a passing car does not wake your phone |
| 🙂 **Known faces** | Add people with a Face ID–style scan in the app; the doorbell recognizes them and rings by name |
| 🎞️ **Clips and activity** | Every ring and motion records a 15 s clip, and you can record from the live view; filter by rings / motion / recorded / saved, keep the ones that matter |
| 👥 **Shared households** | Owner and member roles, invite by code, per-person notification preferences |
| 🔄 **Remote management** | Move the doorbell to another Wi-Fi network and install signed over-the-air updates, from the app |

## Architecture

```mermaid
flowchart LR
    PI["🔔 Doorbell<br/>Raspberry Pi 4<br/>C++ daemon + Python"]
    APP["📱 React PWA<br/>Cloudflare Workers"]

    subgraph AWS["AWS · eu-west-1"]
        API["API<br/>Node.js · Express<br/>REST + WebSocket"]
    end

    DB[("MongoDB Atlas")]
    R2[("Cloudflare R2<br/>clips")]
    LK["LiveKit Cloud<br/>SFU"]

    PI <-- "WebSocket<br/>alerts · commands" --> API
    APP <-- "REST · WebSocket · JWT" --> API
    API --> DB
    API -. "Web Push" .-> APP
    PI -- "pre-signed upload" --> R2
    APP -- "signed playback" --> R2
    PI == "one video stream up" ==> LK
    LK == "a copy to each viewer" ==> APP
```

**Two rules shape everything:**

1. **The API carries no video and no clips.** Video goes through LiveKit; clips go straight from the Pi to storage on a pre-signed URL. Apart from small face photos on their way to storage, the server only issues credentials and records facts, so one small instance is enough.
2. **Alerts and clips travel on separate channels**, because they fail differently. A doorbell press must arrive in under a second; a 15 s clip is megabytes and can wait. On a single channel, an upload would delay a ring.

## Engineering highlights

- **Idempotent event ingest.** The device retries until it gets an answer, so the same press can arrive twice, and a ring can arrive *after* the motion event it upgrades. Both transports go through one `ingestEvent` path: a single MongoDB upsert, plus a compare-and-set that only ever raises motion → ring. Duplicates are silent, concurrent upgrades produce exactly one notification, and the event keeps the earliest sensor time regardless of arrival order.
- **Nothing is lost during a deploy.** The device keeps a bounded offline queue (200 alerts, 24 h, 2 s → 60 s backoff). The server answers *nothing* rather than *no* when it cannot write, because silence means "retry" and a rejection means "drop".
- **Security by design.** JWT auth with server-side revocation ("sign out everywhere"), bcrypt, per-email and per-IP login rate limits, per-device credentials checked in constant time, role checks on every device route, short-lived tokens for video and clips, and OTA bundles signed so even a compromised server cannot push firmware.
- **Production infrastructure as code.** ~40 resources in Terraform: 35 on AWS, plus the Cloudflare DNS records. The API runs as a Docker container behind Caddy (automatic TLS). No SSH port is open — shell and deploys go through AWS Systems Manager. Secrets live in SSM Parameter Store, and CI signs in to AWS with **OIDC**, so there are no AWS keys in GitHub.
- **Automated releases.** GitHub Actions builds the image, pushes to ECR, releases on the server, and verifies the deployment from the outside.

## Tech stack

| Layer | Technologies |
|---|---|
| Frontend | React, Vite, CSS Modules, Service Worker (PWA), Web Push, MediaPipe (in-browser face scan), LiveKit client |
| Backend | Node.js, Express, MongoDB / Mongoose (10 models), WebSocket signaling, JWT, bcrypt |
| Infrastructure | AWS (EC2, ECR, S3, SES, IAM, SSM, CloudWatch), Terraform, Docker, Caddy, Cloudflare (Workers, R2, DNS), LiveKit Cloud |
| CI/CD | GitHub Actions with OIDC, Dependabot |
| Device | C++20, Python, GStreamer, TensorFlow Lite, Buildroot — see the [device repo](https://github.com/israellior/Smart-Home-Security-System-Device) |

## Repository layout

| Path | What |
|---|---|
| [`src/`](src) | React app — live view, activity, sharing, faces, push, Wi-Fi and software settings |
| [`porchlight-backend/`](porchlight-backend) | REST API and WebSocket signaling — [full API reference](porchlight-backend/README.md) |
| [`infra/`](infra) | Terraform, server config and the production runbook — [infra README](infra/README.md) |
| [`.github/workflows/`](.github/workflows) | Build, release and verify pipeline |

## Running locally

```bash
# 1. Backend (needs a MongoDB connection string - see porchlight-backend/README.md)
cd porchlight-backend
cp .env.example .env
npm install
npm run dev            # http://localhost:4000

# 2. Web app
cd ..
npm install
npm run dev            # http://localhost:5173
```

Register an account, then add a doorbell: **Set up later** creates one with no hardware behind it. To point the app at another backend, copy `.env.example` to `.env.local` and set `VITE_API_URL`.

## What I'd do next

- **Scale past one API instance.** The socket registry, talk/record turns and the claim rate limiter live in process memory, which is why the API deliberately runs as a single instance. Moving that state to Redis would allow several instances behind a load balancer.
- **End-to-end tests** for the alert → push → live-view flow, running against a simulated device in CI.

## How it was built

Designed and built by me, from the first commit to production in under 4 weeks, using [Claude Code](https://claude.com/claude-code) as a pair programmer. The design decisions are written down in the device repo's [`DESIGN.md`](https://github.com/israellior/Smart-Home-Security-System-Device/blob/main/DESIGN.md) and [`docs/architecture.md`](https://github.com/israellior/Smart-Home-Security-System-Device/blob/main/docs/architecture.md).

---

<div align="center">
<b>Lior Israel</b> · <a href="https://www.linkedin.com/in/liorisrael1">LinkedIn</a> · <a href="https://github.com/israellior">GitHub</a>
</div>
