# Production

How Porchlight runs in production, how to stand it up from nothing, and
how to operate it afterwards.

```
 doorbell ─┐                                        ┌─> MongoDB Atlas (eu-west-1)
 browser ──┼─ https/wss ─> api.<domain> ─> Caddy ─> API ─┼─> Cloudflare R2 (clips)
           │              (EC2, eu-west-1, Elastic IP)   └─> LiveKit Cloud (tokens only)
           └─ https ────> <domain> (Cloudflare Pages: the React app)
```

- **API**: one Docker container on one EC2 `t4g.small`, behind Caddy, which
  terminates TLS with Let's Encrypt and proxies the signaling WebSocket.
- **Exactly one instance, on purpose.** The socket registry, the talk
  floor and the claim rate limiter live in process memory. A deploy is
  stop-then-start: a few seconds in which doorbells reconnect (they are
  told why, with close code 1012). Going multi-instance means moving that
  state out first. That is also when ECS behind a load balancer starts
  paying for itself.
- **No SSH.** Nothing listens on port 22. Shell access and deploys both go
  through AWS Systems Manager.
- **No AWS keys anywhere in GitHub.** CI authenticates with OIDC and can
  only assume its role from this repo's `production` environment.
- **Secrets live in SSM Parameter Store**, not in git, Terraform state, or
  the image.

| Path | What |
|---|---|
| `terraform/` | Every AWS resource plus the `api.<domain>` DNS record |
| `server/` | What runs on the box: `compose.yaml`, `Caddyfile`, `deploy.sh` |
| `scripts/put-secret.sh` | Stores one secret in Parameter Store |
| `../.github/workflows/deploy-api.yml` | Build, push, release, verify |

> **Git Bash on Windows** rewrites arguments that start with `/` into
> Windows paths, which breaks every `/porchlight/prod/...` parameter name.
> Run `export MSYS_NO_PATHCONV=1` in any shell you use for the commands
> below. `put-secret.sh` sets it for itself.

---

## Standing it up

Once, in this order. Each step says what it needs from the previous one.

### 1. Accounts (by hand)

- **AWS**: new account, Free Plan. Put MFA on the root user straight
  away, then create an **IAM user** for yourself, with console access,
  its own MFA, and `AdministratorAccess`. Don't use root again.

  **Not IAM Identity Center.** It's the usual advice, but using it for
  account access needs an AWS Organization. Creating one on a Free Plan
  account moves the account to the Paid Plan and expires the credits
  immediately.
- **Cloudflare**: buy the domain. Create an API token with
  *Zone → DNS → Edit* on that one zone and nothing else. Note the zone's
  **Zone ID** from its Overview page.
- **Atlas**: a new project `porchlight-prod`, with an M0 cluster on
  **AWS / eu-west-1**. Leave the IP access list empty for now.
- **LiveKit**: a separate project for production, so dev tokens can
  never join prod rooms.
- **R2**: a separate bucket (`porchlight-clips-prod`), with an
  *Object Read & Write* token scoped to that bucket only.
- **Local tools**: Terraform
  (`winget install Hashicorp.Terraform`), and the
  [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  for `aws ssm start-session`.

### 2. Sign the AWS CLI in

The access keys in `~/.aws/credentials` from before are invalid. Move
that file aside, then, with AWS CLI 2.32 or later:

```bash
aws login --profile porchlight --region eu-west-1   # opens the browser; sign in as the IAM user
export AWS_PROFILE=porchlight
aws sts get-caller-identity                         # should print the new account
```

The CLI gets short-lived credentials from your console sign-in and
refreshes them for up to 12 hours. Run `aws login` again after that.
There are no long-lived keys on your machine.

### 3. The Terraform state bucket

The state has to live somewhere before Terraform can run, so this one
bucket is made by hand:

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET=porchlight-tfstate-$ACCOUNT
aws s3api create-bucket --bucket $STATE_BUCKET --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1
aws s3api put-bucket-versioning --bucket $STATE_BUCKET \
  --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket $STATE_BUCKET \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Versioning is what lets you recover from a corrupted or mistaken state.

### 4. Apply

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill it in
export CLOUDFLARE_API_TOKEN=$(cat cloudflare.token)  # gitignored; the token from step 1
terraform init -backend-config="bucket=$STATE_BUCKET"
terraform plan -out tfplan                     # read it
terraform apply tfplan
```

Commit `.terraform.lock.hcl` afterwards. Then:

```bash
terraform output public_ip          # -> step 5
terraform output github_variables   # -> step 7
```

The instance installs Docker on first boot, which takes a minute or two
after `apply` returns.

### 5. Let the server reach Atlas

In `porchlight-prod` → *Network Access*, add `public_ip` as a `/32`
entry. It's an Elastic IP, so it survives the instance being replaced.
Create a database user, and build the connection string with
`/porchlight` as the database name.

### 6. Secrets

```bash
infra/scripts/put-secret.sh MONGODB_URI
infra/scripts/put-secret.sh JWT_SECRET --generate
infra/scripts/put-secret.sh CLAIM_CODE_PEPPER --generate   # once, ever - see below
infra/scripts/put-secret.sh LIVEKIT_URL
infra/scripts/put-secret.sh LIVEKIT_API_KEY
infra/scripts/put-secret.sh LIVEKIT_API_SECRET
infra/scripts/put-secret.sh R2_ACCOUNT_ID
infra/scripts/put-secret.sh R2_ACCESS_KEY_ID
infra/scripts/put-secret.sh R2_SECRET_ACCESS_KEY
infra/scripts/put-secret.sh R2_BUCKET
```

`PUBLIC_API_URL` and `CLIENT_ORIGIN` come from Terraform and follow
the domain. A deploy refuses to start while any required value is
missing, and the error names each one.

**`CLAIM_CODE_PEPPER` is permanent for this database.** Every claim code
is hashed under it, so replacing it silently invalidates every unclaimed
sticker. The script refuses to overwrite it without `--force`.

### 7. GitHub

*Settings → Environments → New environment* `production`:

- **Deployment branches**: *Selected branches* → `main`. This, together
  with the role's trust policy, is what stops a fork's PR from deploying.
- **Environment variables**: one per key in `terraform output
  github_variables`.

### 8. Cloudflare Workers (the frontend)

The React app is served as static assets from a Cloudflare Worker,
configured by `wrangler.jsonc` at the repo root. (Cloudflare Pages still
works but is now its "legacy" workflow.)

*Workers & Pages → Create application → **Connect GitHub*** → this repo
(grant access to this repository only):

| Setting | Value |
|---|---|
| Project name | `porchlight` (must match `name` in `wrangler.jsonc`) |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |
| Build variables | `VITE_API_URL` = `https://api.<domain>/api`, `NODE_VERSION` = `24` |

`VITE_API_URL` must be a **build** variable, not a runtime one: Vite
bakes it into the bundle.

Then *Settings → Domains & Routes → Add → Custom domain* → the apex
`<domain>`. Cloudflare creates the DNS record. Under *Settings → Build*,
set build watch paths to exclude `porchlight-backend/*` and `infra/*`.
Deep links like `/devices/x` work because of `not_found_handling:
"single-page-application"` in `wrangler.jsonc`.

### 9. First release

Merge to `main`, or run **Deploy API** by hand from the Actions tab.
Then check:

```bash
curl https://api.<domain>/api/health     # {"ok":true}
```

Open `https://<domain>` and register. This is a new database, so it's a
new account.

### 10. Move porch-2 to production

porch-2's current certificate points at `http://192.168.0.219:4000`. Mint
it again against production, from inside the container, since that's
where the production secrets and the Atlas allowlist are:

```bash
aws ssm start-session --target <INSTANCE_ID>
sudo docker compose --project-directory /opt/porchlight exec api \
  node scripts/mint-device.mjs --device-id porch-2 --name "Front Door" --json
```

Put that JSON on the Pi at `/boot/firmware/porchlight.json` and reboot.
Firstboot runs again whenever a certificate is present, even on a unit
that was provisioned before. Then claim the doorbell in the app with the
new claim code. The file holds a live credential, so delete your copy
once the Pi has consumed it.

---

## Operating it

| Task | How |
|---|---|
| Deploy | Push to `main`. Only backend or `infra/server` changes trigger it. |
| Roll back | Actions → an older green **Deploy API** run → *Re-run all jobs*. Images are immutable per commit, so that redeploys exactly that commit. |
| Logs | `aws logs tail /porchlight/prod --follow` (streams `api/<id>` and `caddy/<id>`) |
| Shell | `aws ssm start-session --target <INSTANCE_ID>` |
| Change a secret | `put-secret.sh NAME`, then redeploy. The container is recreated when its env changes. |
| New AMI / rebuild server | `terraform apply -replace=aws_instance.api`. The IP, DNS and secrets stay; certificates are re-issued on first start. |

A release that doesn't become healthy within 150 s is rolled back to the
previous image automatically, and the workflow goes red with the failing
container's last log lines.

### Cost

| Item | Monthly |
|---|---|
| EC2 t4g.small | $0 until 2026-12-31 (AWS free trial), about $12 after |
| Public IPv4 (Elastic IP) | about $3.65 |
| EBS 20 GB gp3, ECR, S3, CloudWatch | about $2 |
| Atlas M0, Cloudflare Pages, GitHub Actions | $0 |

New-account credits cover all of it for the first months. The budget
alarm emails at 80% of `monthly_budget_usd` (default $20).

### Known gaps

In rough priority order:

1. **No database backups.** Atlas M0 has none. A nightly `mongodump` to S3
   is the cheap fix; Atlas Flex ($8+/mo) includes snapshots.
2. **OS patching is manual.** Run `sudo dnf upgrade --releasever=latest -y`
   in a session, or set up SSM Patch Manager.
3. **Downtime per deploy** is a few seconds, longer when Atlas M0 fails TLS
   handshakes on the cold pool. It's inherent to single-instance; see the
   top of this file.
4. **Web Push is still a stub.** HTTPS now exists, so it can be finished.
   See `porchlight-backend/src/services/notifications/channels/webPush.js`.
