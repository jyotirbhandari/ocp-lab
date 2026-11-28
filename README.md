# k8s-bookstore-lab: learning Kubernetes and OpenShift by building a real app

A hands-on learning repo. It deploys a small **Bookstore** app (nginx + Node.js API + PostgreSQL + MongoDB) to a **Red Hat OpenShift Developer Sandbox**, using **standard Kubernetes YAML** so the same app can later run on a local cluster (kind/Colima) with Istio, Cilium, Argo CD and Vault.

> **Who is this for?** Anyone who knows basic Docker and wants to understand *why* each Kubernetes object exists, not just copy commands. Every step lists the concept, the YAML, the command (`kubectl` **and** `oc`), how to verify it, and what went wrong when we did it.

> **Living document.** This README is updated as the project grows. The [Roadmap](#14-roadmap) shows what's done and what's next.

---

## Table of contents
1. [Architecture](#1-architecture)
2. [Tech stack](#2-tech-stack)
3. [Repository layout](#3-repository-layout)
4. [Prerequisites](#4-prerequisites)
5. [OpenShift Developer Sandbox: what to know first](#5-openshift-developer-sandbox-what-to-know-first)
6. [Deploy from scratch (step by step)](#6-deploy-from-scratch-step-by-step)
7. [Daily start-up (after the sandbox idles)](#7-daily-start-up-after-the-sandbox-idles)
8. [Verify everything](#8-verify-everything)
9. [Operations runbook](#9-operations-runbook)
10. [CI/CD: building the API image](#10-cicd-building-the-api-image)
11. [Troubleshooting and lessons learned](#11-troubleshooting-and-lessons-learned)
12. [Concepts cheat sheet](#12-concepts-cheat-sheet)
13. [kubectl vs oc](#13-kubectl-vs-oc)
14. [Roadmap](#14-roadmap)
15. [Teardown](#15-teardown)
16. [Local cluster: Colima + kind + Calico](#16-local-cluster-colima--kind--calico)

---

## 1. Architecture

```
Browser
  │  https://bookstore-<namespace>.apps.<cluster-domain>
  ▼
Ingress  ──(OpenShift converts it to a Route, TLS edge)──►  OpenShift router
  ▼
Service "nginx"  ──►  nginx Deployment (2 pods)
                        ├── /        → index.html          (ConfigMap nginx-content)
                        └── /api/*   → proxy_pass api:8080  (ConfigMap nginx-proxy)
                                         ▼
                      Service "api"  ──►  Node.js API Deployment (2–5 pods, HPA)
                                           ├── Service "postgres" (headless) → StatefulSet postgres-0 + PVC   (books)
                                           └── Service "mongo"    (headless) → StatefulSet mongo-0    + PVC   (reviews)

Job      db-migrate  → creates SQL tables + seed data + Mongo indexes (safe to re-run)
CronJob  pg-backup   → nightly pg_dump to its own PVC (pg-backups)
Job      pg-restore  → manual restore from a backup file (runbook only)
NetworkPolicies      → default deny; only nginx→api, api/migrate/backup→postgres, api/migrate→mongo
```

**Why two databases?** Each does what it's good at:
- **PostgreSQL (relational):** books and orders. Fixed schema, joins, transactions.
- **MongoDB (document):** reviews. Flexible shape (rating, comment, optional fields).

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Cluster | Red Hat OpenShift Developer Sandbox (ROSA, on AWS) | Free; real OpenShift with real restrictions (no admin) |
| CNI | OVN-Kubernetes (OpenShift default) | Enforces NetworkPolicy |
| Storage | AWS EBS `gp3` (cluster default StorageClass) | `WaitForFirstConsumer`, ReadWriteOnce |
| Reverse proxy | `registry.access.redhat.com/ubi9/nginx-124` | Runs as non-root, OpenShift-friendly |
| API | Node.js 24 (`ubi9/nodejs-24`), Express, `pg`, `mongodb` | Small; uses 12-factor env config |
| PostgreSQL | `quay.io/sclorg/postgresql-16-c9s` | Same as the RHEL image but public; non-root (UID 26) |
| MongoDB | `docker.io/library/mongo:7.0` | No Red Hat image exists; runs under OpenShift's random UID |
| Images | GitHub Actions → **GHCR** (`ghcr.io/jyotirbhandari/bookstore-api`) | Free, public, any cluster can pull |
| Manifests | Plain YAML + **Kustomize** (`kubectl apply -k`) | Built into kubectl; Argo CD uses it later |

---

## 3. Repository layout

```
k8s-bookstore-lab/
├── .github/workflows/
│   └── build-api.yml            CI: build + push the API image on changes to app/api/**
├── app/api/                     SOURCE CODE (what we build)
│   ├── Dockerfile               UBI Node.js image; group-0 permissions for OpenShift's random UID
│   ├── package.json
│   ├── src/
│   │   ├── db.js                Postgres pool (reads PG* env vars) + Mongo client
│   │   ├── server.js            HTTP API: /api/healthz, /api/readyz, /api/info, /api/books, /api/books/:id/reviews
│   │   └── migrate.js           One-shot migration runner (schema_migrations table, exit 0/1)
│   └── migrations/              001_create_books.sql, 002_seed_books.sql
├── platform/                    CLUSTER SETUP (local only; OpenShift provides its own)
│   ├── kind/cluster.yaml        2 nodes, default CNI off, podSubnet 10.244.0.0/16, ports 80/443
│   ├── calico/values.yaml       Tigera operator values: IP pool = podSubnet, VXLANCrossSubnet
│   ├── metrics-server/values.yaml   --kubelet-insecure-tls (kind's self-signed kubelet certs; lab only)
│   └── traefik/values.yaml      ingress controller: control-plane node, hostPort 80/443, Service ClusterIP
└── deploy/                      KUBERNETES YAML (how it runs)
    ├── base/                    THE SAME ON EVERY CLUSTER ("main recipe"). Never applied directly.
    │   ├── kustomization.yaml   lists: postgres, mongo, api, nginx, backup, policies (NOT migrate)
    │   ├── postgres/            secret(.example).yaml, service.yaml (headless), statefulset.yaml
    │   ├── mongo/               secret(.example).yaml, service.yaml (headless), statefulset.yaml
    │   ├── migrate/             job.yaml (run separately, at the right moment)
    │   ├── api/                 deployment.yaml, service.yaml, hpa.yaml
    │   ├── nginx/               configmap-content.yaml, configmap-proxy.yaml, deployment.yaml, service.yaml
    │   ├── backup/              pvc.yaml, cronjob.yaml, restore-job.yaml (manual, NOT in kustomization)
    │   └── policies/            default-deny-ingress.yaml, allow-*.yaml
    └── overlays/                WHAT'S DIFFERENT PER CLUSTER ("sticky note"). This is what you apply.
        ├── openshift/           + ingress.yaml (sandbox host, openshift-default class, route edge annotation)
        └── local/               + namespace.yaml (bookstore), ingress.yaml (Traefik, bookstore.localhost),
            │                      allow-ingress-to-nginx.yaml (Traefik ns → nginx:8080),
            │                      images: multi-arch API tag, patches: nginx 1 replica, HPA min 1
            └── migrate/         the migration Job for kind: base/migrate + namespace + multi-arch tag
```

**Rules used in this repo**
- `app/` = code. `deploy/` = YAML. Never mix them.
- **Every folder has a `kustomization.yaml`** listing exactly which files or folders to include. Apply with **`-k`** (not `-f`).
- **Apply an overlay, never the base:** `kubectl apply -k deploy/overlays/<cluster>`. The base has no entry point (Ingress), so applying it on the sandbox would remove the public URL.
- **Real secrets are never committed.** `secret.yaml` is in `.gitignore`; only `secret.example.yaml` (placeholders) is in Git.
- **Standard Kubernetes first.** Cluster-specific bits live only in overlays, so the base runs on OpenShift, kind, minikube and k3s.
- **Platform vs. app:** cluster setup (CNI such as Calico/Cilium, Istio control plane, ingress controller, Argo CD) will live in `platform/`. App differences per cluster live in `deploy/overlays/`.

### Kustomize base + overlays, in plain words
One **main recipe** (`base/`) and one small **sticky note per kitchen** (`overlays/<cluster>/`) listing only what's different there. Kustomize combines them: `final YAML = base + overlay`.

| Kustomize feature | Plain meaning | Used in |
|---|---|---|
| `resources:` | Include these files/folders (folders = nested kustomizations) | everywhere |
| `namespace:` | Put every object into this namespace | `local` → `bookstore` |
| `images:` | Change an image tag everywhere it appears, in one place | `local` → multi-arch `sha-b41a021` |
| `patches:` | Change specific fields of an object (strategic merge or JSON patch `op/path/value`) | `local` → nginx `replicas: 1`, HPA `minReplicas: 1` |

Preview without applying, and compare with the cluster:
```bash
kubectl kustomize deploy/overlays/local | less                 # render the final YAML
kubectl diff -k deploy/overlays/openshift; echo "exit: $?"     # 0 = cluster already matches
```
**Refactoring safely:** when we restructured `deploy/` into base + overlays, `kubectl diff -k deploy/overlays/openshift` returned **exit 0**: the structure changed, but what runs didn't.

---

## 4. Prerequisites

| Tool | Install (macOS) | Used for |
|---|---|---|
| `oc` | `brew install openshift-cli` | OpenShift CLI (includes every kubectl command + OpenShift extras) |
| `kubectl` | `brew install kubectl` | Standard Kubernetes CLI (portable skills) |
| `helm` | `brew install helm` | Later stages |
| `git` | Xcode CLT / brew | Repo |
| A Red Hat account | developers.redhat.com → Developer Sandbox | The cluster |
| A GitHub account | Fork/clone this repo | CI + image registry (GHCR) |

**Log in to the sandbox.** In the web console, click your username → **Copy login command** → **Display Token**, then run:
```bash
oc login --token=sha256~XXXX --server=https://api.<cluster>.openshiftapps.com:6443
oc whoami && oc project          # kubectl now works too (same ~/.kube/config)
```
⚠️ The token works like a password. Never paste it anywhere public.

---

## 5. OpenShift Developer Sandbox: what to know first

| Fact | Impact |
|---|---|
| **One namespace** (`<username>-dev`), **no cluster-admin** | Can't create projects, CRDs, operators, or cluster-scoped objects (no Argo CD or Istio here) |
| **ResourceQuota** `compute-deploy`: `requests.cpu: 3`, `limits.cpu: 30`, memory 30Gi | Every pod's requests/limits add up; exceeding any line → pod **rejected** (see [§11](#11-troubleshooting-and-lessons-learned)) |
| **ResourceQuota** `compute-build`: separate budget for pods with a deadline (Jobs with `activeDeadlineSeconds`, builds) | Jobs don't use up your app's budget |
| **LimitRange** default: request `10m / 64Mi`, limit `1 CPU / 1000Mi` | Pods without `resources:` get these automatically |
| **SCC `restricted-v2`** | Containers run as a **random UID** (e.g. 1008100000), never root. Root-only images fail. |
| **Idling** after ~12h | Deployments/StatefulSets are scaled to 0. **PVCs, Secrets, Services, Jobs survive.** See [§7](#7-daily-start-up-after-the-sandbox-idles). |
| **10 pre-created NetworkPolicies**, including `allow-same-namespace` | NetworkPolicies are additive: `allow-same-namespace` makes our restrictions useless until it's removed ([§9.4](#94-network-policies)) |
| **Ingress → Route conversion** | An Ingress with `tls:` but **no `secretName` is silently ignored**. Use the annotation `route.openshift.io/termination: edge` instead ([§11](#11-troubleshooting-and-lessons-learned)) |

Inspect them yourself:
```bash
kubectl describe quota
kubectl describe limitrange
kubectl get networkpolicy
kubectl get storageclass
```

---

## 6. Deploy from scratch (step by step)

> **Two ways to deploy:**
> - **Learning (this section):** apply one component at a time from `deploy/base/<component>`, so you see each piece work before the next.
> - **Everyday:** `kubectl apply -k deploy/overlays/openshift` deploys everything at once (then run the migration Job). See [§7](#7-daily-start-up-after-the-sandbox-idles).
>
> **Order matters:** secrets → databases → migrations → API → nginx → ingress → backup → network policies.
> Every `kubectl` command below also works with `oc`.
> **Always dry-run first:** `kubectl apply -k <folder> --dry-run=server`

```bash
git clone https://github.com/jyotirbhandari/k8s-bookstore-lab.git
cd k8s-bookstore-lab
```

### Step 1: Secrets (credentials for the databases)
**Concept:** a Secret keeps passwords out of the YAML that's in Git. Pods read them as environment variables. (Base64 is **not** encryption; Vault comes later.)
```bash
cp deploy/base/postgres/secret.example.yaml deploy/base/postgres/secret.yaml
cp deploy/base/mongo/secret.example.yaml    deploy/base/mongo/secret.yaml
# edit both files: replace CHANGE_ME with real passwords
git status        # secret.yaml must NOT appear (it's gitignored)

# Apply the secrets SEPARATELY: they are not part of any kustomization
kubectl apply -f deploy/base/postgres/secret.yaml
kubectl apply -f deploy/base/mongo/secret.yaml
# (local kind cluster: add  -n bookstore  after creating the namespace)
```
> ℹ️ **Why aren't the secrets in the kustomizations?** `secret.yaml` exists only on your machine (gitignored). If a kustomization listed it, anyone who clones the repo, **including Argo CD**, would fail with `secret.yaml: no such file or directory`, and the whole overlay would fail to build. So Git describes the app without secrets, and secrets are delivered separately: by hand now, by **Vault + External Secrets** later.
>
> **When do you need to apply them?** Only when they don't exist yet in a cluster: a new cluster, or after a teardown. They survive sandbox idling and `kubectl apply` (apply never deletes objects that disappear from your files; that's called *pruning*).
>
> **Test that the repo builds without local files** (simulates Argo CD; commit first, because clone copies committed files only):
> ```bash
> cd /tmp && rm -rf clone-test && git clone -q ~/tools/repos/k8s-bookstore-lab clone-test
> kubectl kustomize clone-test/deploy/overlays/openshift > /dev/null && echo "BUILD OK"
> kubectl kustomize clone-test/deploy/overlays/local     > /dev/null && echo "BUILD OK"
> rm -rf /tmp/clone-test
> ```

### Step 2: PostgreSQL (StatefulSet + PVC + headless Service)
**Concept:** a **StatefulSet** gives the database a stable name (`postgres-0`) and **its own disk** (PVC `data-postgres-0`) that survives pod restarts. A **headless Service** (`clusterIP: None`) gives it a DNS name: `postgres`.
```bash
kubectl apply -k deploy/base/postgres/ --dry-run=server
kubectl apply -k deploy/base/postgres/
kubectl get pvc,pods -l app=postgres -w     # PVC Pending → Bound once the pod starts (WaitForFirstConsumer)
```

### Step 3: MongoDB
Same pattern as Postgres; different image, port (27017) and data path (`/data/db`).
```bash
kubectl apply -k deploy/base/mongo/
kubectl get pods -l app=mongo -w            # wait for 1/1
kubectl exec mongo-0 -- id                  # random UID assigned by OpenShift
```

### Step 4: Migration Job (schema + seed data)
**Concept:** a **Job** runs to completion. It uses the **same API image** with a different command (`node src/migrate.js`). Exit code 0 = success, 1 = retry (up to `backoffLimit`). A `schema_migrations` table makes it **safe to re-run**.
```bash
kubectl apply -k deploy/base/migrate/
kubectl get pods -l app=db-migrate -w       # Completed
kubectl logs job/db-migrate                 # apply 001…, apply 002…, mongo indexes ensured
kubectl exec postgres-0 -- psql -d bookstore -c 'SELECT * FROM books;'
```

### Step 5: API (Deployment + Service + HPA)
**Concept:** the API reads DB credentials from Secrets (`secretKeyRef` renames `POSTGRESQL_USER` → `PGUSER`).
- **readinessProbe** `/api/readyz` (checks both DBs): failing → the pod gets no traffic.
- **livenessProbe** `/api/healthz`: failing → the container is restarted.
- **HPA** scales 2–5 pods at 60% of the CPU request. The Deployment has **no `replicas:` field**, because the HPA owns it.
```bash
kubectl apply -k deploy/base/api/
kubectl get pods -l app=api -w              # 0/1 → 1/1 once readyz passes
kubectl get hpa api                         # cpu: 4%/60%, REPLICAS 2
```

### Step 6: nginx + Ingress (public URL)
**Concept:** nginx serves `index.html` and forwards `/api/` to the `api` Service. The UBI nginx image loads extra config from `/opt/app-root/etc/nginx.default.d/*.conf`, so the proxy rule is mounted there from a ConfigMap. The **Ingress** is standard Kubernetes; OpenShift turns it into a Route.

The Ingress is **cluster-specific**, so it lives in the overlay, not the base.

⚠️ **Edit the host first:** `deploy/overlays/openshift/ingress.yaml` → `host: bookstore-<your-namespace>.apps.<your-cluster-domain>` (find your domain in the console URL).
```bash
kubectl apply -k deploy/base/nginx/                 # nginx Deployment, Service, ConfigMaps
kubectl apply -k deploy/overlays/openshift/         # adds the Ingress (everything else is unchanged)
kubectl get ingress bookstore
oc get route                                # auto-created route, TERMINATION: edge
```
Open `https://bookstore-<namespace>.apps.<cluster-domain>`. You should see the Bookstore with 3 books.

### Step 7: Backups (PVC + CronJob)
**Concept:** a **CronJob** creates a Job on a schedule (`0 2 * * *` = 02:00 **UTC**). It runs `pg_dump` (same major version as the server) into a **separate PVC**.
```bash
kubectl apply -k deploy/base/backup/
kubectl get cronjob pg-backup
```
Test it right away (see [§9.2](#92-backups-and-restore)).

### Step 8: Network policies
**Concept:** NetworkPolicies are a firewall for pods, based on labels. **Allows add up; there's no "deny" rule.** `default-deny-ingress` selects all pods and allows nothing, and the `allow-*` policies open only what's needed.
```bash
kubectl apply -k deploy/base/policies/ --dry-run=server
kubectl apply -k deploy/base/policies/
```
In the **sandbox**, you must also remove `allow-same-namespace`, or nothing is restricted. Follow [§9.4](#94-network-policies) (save a backup first, **after** applying our policies).

---

## 7. Daily start-up (after the sandbox idles)

The sandbox scales workloads to 0 after ~12h. Data (PVCs) is safe. Re-applying the overlay restores everything:
```bash
cd k8s-bookstore-lab
kubectl get deploy,sts,pods,pvc                           # what's there?
kubectl diff -k deploy/overlays/openshift                 # what would change?

kubectl apply -k deploy/overlays/openshift                # everything except the migration Job
kubectl get pods -l 'app in (postgres,mongo)' -w          # wait for 1/1 on both DBs

kubectl delete job db-migrate --ignore-not-found          # a Job can't be re-applied
kubectl apply -k deploy/base/migrate/
kubectl logs -f job/db-migrate                            # expect "skip" lines

kubectl get pods                                          # everything 1/1
```
**Why is it OK to start everything at once?** If the API starts before the DBs, `/api/readyz` fails and its pods stay `0/1` (not ready, but not broken). They become ready on their own once the DBs are up. The **migration Job** is the exception: run it after the DBs are ready. (Later, Argo CD sync waves/hooks will handle this ordering automatically.)

---

## 8. Verify everything

```bash
kubectl get pods,svc,ingress,hpa,cronjob,pvc,networkpolicy
kubectl top pods                                          # needs metrics (built into OpenShift)

# API directly (bypasses nginx): Ctrl+C to stop the port-forward
kubectl port-forward svc/api 8080:8080 &
curl -s localhost:8080/api/readyz                         # {"status":"ready"}
curl -s localhost:8080/api/books
curl -s -X POST localhost:8080/api/books/1/reviews -H 'Content-Type: application/json' \
     -d '{"rating":5,"comment":"Great"}'
curl -s localhost:8080/api/books/1/reviews

# Through the public URL (load-balanced across API pods)
URL=https://bookstore-<namespace>.apps.<cluster-domain>
for i in 1 2 3 4 5 6; do curl -s $URL/api/info; echo; done   # pod name varies
```
> Note: `port-forward` sticks to **one** pod; use the public URL to see load balancing.

---

## 9. Operations runbook

### 9.1 Migrations
```bash
kubectl delete job db-migrate
kubectl apply -k deploy/base/migrate/
kubectl logs job/db-migrate          # already-applied files print "skip"
kubectl exec postgres-0 -- psql -d bookstore -c 'SELECT * FROM schema_migrations;'
```
- To add a migration: create `app/api/migrations/003_<name>.sql` → push (CI builds a new image) → update the image tag in `deploy/base/migrate/job.yaml` and `deploy/base/api/deployment.yaml` → run the Job.
- Each file runs in **one transaction**: a failure rolls back the whole file and isn't recorded, so it's retried next time.

### 9.2 Backups and restore
**Take a backup now** (same template as the nightly run):
```bash
kubectl create job pg-backup-manual-$(date +%s) --from=cronjob/pg-backup
kubectl get pods -l app=pg-backup -w
kubectl logs job/<job-name>          # "backup written: /backups/bookstore-YYYYMMDD-HHMMSS.sql"
```
Backups older than 7 days are deleted automatically by the CronJob script.

**Restore (disaster drill)**
```bash
# 1. (drill only) simulate an accident
kubectl exec postgres-0 -- psql -d bookstore -c 'DROP TABLE books;'

# 2. set BACKUP_FILE in deploy/base/backup/restore-job.yaml to the file from the backup logs
# 3. run the restore: applied with -f because it's NOT part of the kustomization
kubectl apply -f deploy/base/backup/restore-job.yaml
kubectl logs -f job/pg-restore       # "restore complete"
kubectl exec postgres-0 -- psql -d bookstore -c 'SELECT id, title FROM books;'

# 4. clean up
kubectl delete job pg-restore
```
Why the restore works: backups are taken with `pg_dump --clean --if-exists` (drop + recreate). The restore uses `psql -v ON_ERROR_STOP=1` (fail loudly), `backoffLimit: 0` (a human decides about retries) and mounts the backups `readOnly`.

> ⚠️ Re-running migrations does **not** fix a dropped table: `schema_migrations` still says 001/002 were applied. That's exactly why backups exist.

**Pause or resume the nightly schedule**
```bash
kubectl patch cronjob pg-backup -p '{"spec":{"suspend":true}}'
kubectl patch cronjob pg-backup -p '{"spec":{"suspend":false}}'
```

### 9.3 Autoscaling (HPA)
```bash
kubectl get hpa api -w                                     # tab 1
kubectl get pods -l app=api -w                             # tab 2
kubectl run load --image=registry.access.redhat.com/ubi9/ubi-minimal --restart=Never \
  --command -- /bin/sh -c 'for i in 1 2 3 4; do (while true; do curl -s -o /dev/null http://api:8080/api/books; done) & done; wait'
# watch it scale up, then:
kubectl delete pod load                                    # scale-down follows after ~5 minutes
kubectl get hpa api -o yaml | grep -A20 behavior           # the defaults: scaleUp 0s, scaleDown 300s windows
```
The HPA percentage is relative to the **request** (API request = 50m, so 60% = 30m).

### 9.4 Network policies
**Test connectivity** (bash's `/dev/tcp`, no extra tools needed):
```bash
t() { kubectl exec deploy/$1 -- bash -c "timeout 3 bash -c '</dev/tcp/$2/$3' && echo '$1 -> $2:$3 OPEN' || echo '$1 -> $2:$3 BLOCKED'"; }
t nginx postgres 5432     # expected: BLOCKED
t nginx mongo 27017       # expected: BLOCKED
t api   postgres 5432     # expected: OPEN
t api   mongo 27017       # expected: OPEN
```

**Remove the sandbox's `allow-same-namespace`** (only after our policies are applied):
```bash
mkdir -p ~/k8s-bookstore-lab-backups
kubectl get networkpolicy allow-same-namespace -o yaml > ~/k8s-bookstore-lab-backups/allow-same-namespace.backup.yaml
kubectl delete networkpolicy allow-same-namespace
# re-run the tests above + refresh the website
```

**Restore it** (undo):
```bash
kubectl apply -f ~/k8s-bookstore-lab-backups/allow-same-namespace.backup.yaml
```
> Keep the backup **outside** the repo (or add `*.backup.yaml` to `.gitignore`). It's sandbox-specific.

**Remove our policies** (everything back to open):
```bash
kubectl delete -k deploy/base/policies/
```

**Allowed traffic**

| Destination | Allowed sources | Port |
|---|---|---|
| nginx | OpenShift router (sandbox policy `allow-from-openshift-ingress`) | 8080 |
| api | `app=nginx` | 8080 |
| postgres | `app in (api, db-migrate, pg-backup, pg-restore)` | 5432 |
| mongo | `app in (api, db-migrate)` (least privilege) | 27017 |

### 9.5 Rollouts and rollbacks
```bash
kubectl rollout status deployment/api
kubectl rollout history deployment/api
kubectl rollout undo deployment/api --to-revision=<n>   # always name a revision: "previous" may be the broken one
```

---

## 10. CI/CD: building the API image

`.github/workflows/build-api.yml` runs on every push to `main` that changes `app/api/**` (or via **Run workflow** in the Actions tab):
1. Checkout → **QEMU** → Buildx → log in to GHCR with the built-in `GITHUB_TOKEN` (`permissions: packages: write`; no secrets to manage)
2. Tags: `sha-<short-commit>` (immutable, used in the YAML) + `latest`
3. **Multi-arch:** `linux/amd64` (sandbox / x86 nodes) + `linux/arm64` (kind on Apple Silicon). One tag points to a **manifest list**, and each cluster pulls the build that matches its nodes, so the YAML is the same everywhere.

**Build time:** about 37s for amd64 only → about 1m42s with arm64. The arm64 half is **emulated by QEMU** on GitHub's x86 runner. That's fine here (pure-JavaScript dependencies). Apps with native modules (bcrypt, sharp…) can take far longer under emulation; teams then build each architecture on native runners (e.g. `ubuntu-24.04-arm`) and merge the manifests.

Check an image without pulling it:
```bash
oc image info ghcr.io/jyotirbhandari/bookstore-api:sha-<commit> --filter-by-os=linux/amd64
```
- Without `--filter-by-os` you see the manifest list: `linux/amd64`, `linux/arm64`, and `unknown/unknown`.
- `unknown/unknown` = a **build provenance attestation** (one per architecture), not an image.
- Check that a base image supports your architectures **before** adding them to `platforms` (e.g. `oc image info registry.access.redhat.com/ubi9/nodejs-24` lists `linux/arm64/v8`).
- The package is public because it's linked to the public repo (inherited access).

**Deploying a new version:**
- **OpenShift:** the tag is still set in `deploy/base/api/deployment.yaml` and `deploy/base/migrate/job.yaml`. Update both → `kubectl apply -k deploy/overlays/openshift`.
- **Local:** the tag is set once in `deploy/overlays/local/kustomization.yaml` → `images:` → `newTag`.
- (Argo CD will automate this later.)

> ⚠️ **Known gap:** `migrate/` isn't part of the base kustomization, so an overlay's `images:` and `namespace:` don't reach the migration Job. It's handled when we run it locally (Stage 1).

> ℹ️ First multi-arch image: `sha-b41a021`. The sandbox YAML still uses `sha-4b616d7` (amd64-only), which works there because sandbox nodes are amd64.

---

## 11. Troubleshooting and lessons learned

Real problems we hit while building this, and how we found them.

| Symptom | Cause | How we found it | Fix |
|---|---|---|---|
| `ImagePullBackOff` | Typo in the image name (`redhat/com` instead of `redhat.com`) | `kubectl describe pod` → `Image:` + Events | Fix the name (`kubectl set image` or edit the YAML) |
| `CrashLoopBackOff`, logs print "This is a S2I … base image" | `ubi9/nginx-*` is an S2I **builder** image; its default command prints usage and exits | `kubectl logs <pod>` | `command: ["nginx", "-g", "daemon off;"]` |
| Deployment stuck at `READY 1/2`, no pod errors | **Quota exceeded**: the ReplicaSet couldn't create the pod | `kubectl describe rs -l app=<x>` / `kubectl get events \| grep quota` | Lower the requests or the replicas |
| `no matches for kind "Kustomization"` | Used `-f` on a folder with `kustomization.yaml` | Error text | Use **`-k`** for folders with a kustomization |
| Secret applied twice | `-f folder/` picks up `secret.example.yaml` too | Dry-run output | Use `-k` (only listed files) |
| PVC stays `Pending` | StorageClass `WaitForFirstConsumer` (EBS is zonal) | `kubectl describe pvc` | Normal; it binds when a pod uses it |
| API pods `0/1 Running` | readinessProbe failing (DBs not reachable yet) | `kubectl describe pod` → Events | Start the DBs first; it recovers by itself |
| `pg_dump: permission denied for table test` | The table was created by hand as the **postgres superuser** (via `kubectl exec psql`) | Job logs + `\dt` Owner column | Drop it or `ALTER TABLE … OWNER TO bookstore`. Make schema changes via migrations only. |
| Ingress created, **no Route**, no events, "Application is not available" | `tls:` without `secretName` → the sandbox's Ingress-to-Route conversion ignores it | `oc get route` empty; removed one thing at a time | Remove `tls:`, add the annotation `route.openshift.io/termination: edge` |
| API dropped to 1 pod briefly when adding the HPA | Removing `replicas:` from the YAML → apply deleted the field → default 1 → HPA scaled back to 2 | `kubectl get pods` | Expected; in production use `kubectl apply edit-last-applied` first |
| NetworkPolicy has no effect | The sandbox's `allow-same-namespace` (policies add up) | `kubectl get networkpolicy` | Remove it ([§9.4](#94-network-policies)) |
| Port-forward always hits the same pod | `port-forward svc/x` picks one pod | `/api/info` | Test load balancing via the public URL |
| Fresh clone: `accumulating resources … secret.yaml: no such file or directory` | A kustomization listed a gitignored file | Clone the repo to `/tmp` and run `kubectl kustomize` | Remove secrets from kustomizations; apply them separately |
| Clone test still fails after fixing | The fix wasn't **committed**; `git clone` copies committed files only | `git status` shows ` M …kustomization.yaml` | Commit, then re-test |
| Pod `Completed` + restarts with empty logs | `server.js` was missing `app.listen()` (file truncated) | Code review before the build | Keep files complete; `node --check` |
| `helm install` Calico: `no matches for kind "Installation" … ensure CRDs are installed first` | Since Calico v3.32 the CRDs are **not** in the `tigera-operator` chart | `helm show crds … \| grep -c CustomResourceDefinition` → 0; chart README | Apply the `crd.projectcalico.org.v1` chart first (`helm template … \| kubectl apply --server-side -f -`) |
| Traefik chart: `at '/service': additional properties 'type' not allowed` | Chart 43 moved the Service type to `service.spec.type`; its values **schema** rejects unknown keys | `helm install … --dry-run=server`; `helm show values … \| grep -n -B6 'type: LoadBalancer'` | `service: { spec: { type: ClusterIP } }` |
| `zsh: no such file or directory: VERSION` | A `<VERSION>` placeholder was pasted; zsh reads `<` as input redirection | Error text | Put the real chart version |
| `bookstore.localhost` **hangs**, then `504 Gateway Timeout` from Traefik | `default-deny-ingress` blocks Traefik → nginx (Calico silently drops). On the sandbox, OpenShift's own `allow-from-openshift-ingress` hid this | `curl -v -m 40` → `Connected` + 504 after ~30s; port-forward works (bypasses policies) | `allow-ingress-to-nginx` in the overlay (from the ingress controller's namespace) |
| Fresh cluster: API `CrashLoopBackOff`, then fine after ~2 min | `server.js` exits if Mongo isn't reachable within 3s at start-up; all pods start together on a new cluster | `kubectl logs deploy/api --previous` | Self-heals once Mongo is up. Better: retry in the app, or an initContainer |
| Migration Job on kind: `exec format error` (expected if not fixed) | `base/migrate` has the amd64-only tag; `migrate/` isn't in the overlay, so `images:` doesn't reach it | `kubectl kustomize deploy/overlays/local \| grep image:` (Job missing) | `deploy/overlays/local/migrate/` with its own `images:` |
| kind nodes `NotReady`, CoreDNS `Pending` | No CNI yet (`disableDefaultCNI: true`) | `kubectl describe node` → `cni plugin not initialized` | Expected until Calico is running |
| `docker.io` pull fails with `toomanyrequests` | Docker Hub anonymous rate limit | Events | Use `mirror.gcr.io/library/<image>` |

**General debugging order:** `get` → `describe` (Events!) → `logs` / `logs --previous` → `get events --sort-by=.lastTimestamp` → `exec` into the pod.

---

## 12. Concepts cheat sheet

| Object | One-line purpose | In this repo |
|---|---|---|
| Pod | Smallest unit: one or more containers sharing a network | Created by the controllers below |
| Deployment → ReplicaSet → Pod | Stateless apps; rolling updates; rollback via old ReplicaSets | `api`, `nginx` |
| StatefulSet | Stable names + one PVC per pod; ordered startup | `postgres`, `mongo` |
| Job / CronJob | Run to completion / on a schedule | `db-migrate`, `pg-backup`, `pg-restore` |
| Service (ClusterIP) | Stable virtual IP + DNS name, load-balances by label | `api`, `nginx` |
| Service (headless) | DNS → pod IP directly | `postgres`, `mongo` |
| Ingress / Route | HTTP(S) from outside → Service | `bookstore` (Ingress → auto Route) |
| ConfigMap / Secret | Config / credentials outside the image | nginx files / DB passwords |
| PVC / StorageClass | Persistent disk request / how disks are created | `data-postgres-0`, `pg-backups` / `gp3` |
| HPA | Scale replicas on metrics | `api` 2–5 |
| NetworkPolicy | Pod firewall (L3/L4, label-based, additive) | `deploy/base/policies/` |
| ResourceQuota / LimitRange | Namespace budget / per-pod defaults | Set by the sandbox |
| requests vs limits | Guaranteed (scheduling, quota, HPA %) vs maximum (CPU throttled, memory OOMKilled) | All pods |
| QoS class | Guaranteed (req = lim) > Burstable > BestEffort (evicted first) | `api` = Burstable |
| Probes | readiness = traffic on/off, liveness = restart | `api`, `nginx`, DBs |

---

## 13. kubectl vs oc

`oc` includes every `kubectl` command. Both use `~/.kube/config`.

| Task | kubectl | oc |
|---|---|---|
| Log in | (kubeconfig set up beforehand) | `oc login --token=… --server=…` |
| Switch namespace | `kubectl config set-context --current --namespace=x` | `oc project x` |
| Routes | `kubectl get routes` (works on OpenShift) | `oc get route`, `oc expose service x` |
| Inspect a remote image | none | `oc image info <image> --filter-by-os=linux/amd64` |
| Pod metrics | `kubectl top pods` | `oc adm top pods` |
| Builds (OpenShift only) | none | `oc new-app`, `oc start-build`, `oc logs -f bc/x` |

---

## 14. Roadmap

**OpenShift sandbox**
- [x] Pods, Deployments, rollouts/rollbacks, quotas, LimitRange, QoS
- [x] PostgreSQL + MongoDB StatefulSets with PVCs
- [x] Node.js API, GitHub Actions → GHCR
- [x] Migration Job (idempotent)
- [x] API Deployment with probes
- [x] nginx reverse proxy + Ingress (→ Route, edge TLS)
- [x] Backup CronJob + restore drill
- [x] HPA
- [x] NetworkPolicies (incl. removing the sandbox's `allow-same-namespace`)

**Before going local**
- [x] Multi-arch image (`linux/amd64` + `linux/arm64`), first tag `sha-b41a021`
- [x] Kustomize `base/` + `overlays/{openshift,local}` (verified with `kubectl diff`: exit 0)
- [x] Secrets out of `kustomization.yaml` (fresh-clone build test: BUILD OK for both overlays)

**Local cluster (Colima + kind)**
- [ ] Stage 1: kind (multi-node) + **Calico** + metrics-server + ingress + Bookstore
  - [x] kind cluster `bookstore` (2 nodes, Kubernetes v1.37) on Colima
  - [x] Calico v3.33.1 (Tigera operator); nodes Ready
  - [x] metrics-server 3.14.0 (`kubectl top` works)
  - [x] Traefik 43.0.0 (ingress controller; ingress-nginx is retired)
  - [x] Bookstore via `deploy/overlays/local` → http://bookstore.localhost (books from local Postgres)
- [ ] Stage 2: **Istio sidecar mode**: mTLS, AuthorizationPolicy, Prometheus, Grafana, Kiali, tracing, canary, fault injection
- [ ] Stage 3: **Istio ambient mode** (sidecar → ztunnel migration)
- [ ] Stage 4: **Cilium** (eBPF) + Hubble; compare with Istio
- [ ] Argo CD (GitOps) and Vault + External Secrets

---

## 15. Teardown

```bash
kubectl delete -k deploy/base/migrate/ --ignore-not-found   # the Job isn't part of the overlay
kubectl delete -k deploy/overlays/openshift                 # everything else (incl. the Ingress)
kubectl delete secret postgres-credentials mongo-credentials  # secrets are not part of the overlay

# StatefulSet PVCs are NOT deleted automatically (on purpose: data safety).
kubectl get pvc
kubectl delete pvc data-postgres-0 data-mongo-0       # ⚠️ permanently deletes the data (ReclaimPolicy: Delete)
```
To restore the sandbox's default network behaviour, re-apply `allow-same-namespace` ([§9.4](#94-network-policies)).

---

## 16. Local cluster: Colima + kind + Calico

**Layers:** Mac → **Colima** VM (Linux, Docker engine) → **kind** "nodes" (Docker containers running kubeadm-built Kubernetes, containerd inside) → your pods.

| Tool | Role |
|---|---|
| Colima | The Linux machine (6 CPU / 8 GiB used here; k3s **off**) |
| kind | Builds a multi-node, upstream Kubernetes cluster from `platform/kind/cluster.yaml` |
| Calico | The CNI: pod IPs, routing (VXLAN), NetworkPolicy enforcement |

### 16.1 Create the cluster
```bash
colima list                                     # Running, docker runtime
kind create cluster --config platform/kind/cluster.yaml
kubectl config current-context                  # kind-bookstore  ⚠️ check before every apply
kubectl get nodes                               # NotReady: expected, no CNI yet
```
- `disableDefaultCNI: true` turns off kindnet so Calico can be the CNI.
- `podSubnet` must match Calico's IP pool `cidr`.
- `extraPortMappings` 80/443 + label `ingress-ready=true` let `http://bookstore.localhost` reach the ingress controller.
- Switch clusters with `kubectl config use-context <name>`; `kubectl config get-contexts` lists them.

### 16.2 Install Calico (CRDs first, then the operator)
```bash
helm repo add projectcalico https://docs.tigera.io/calico/charts && helm repo update

# 1. CRDs (separate chart since v3.32; server-side apply because some CRDs are very large)
helm template calico-crds projectcalico/crd.projectcalico.org.v1 --version v3.33.1 \
  | kubectl apply --server-side -f -

# 2. Operator + Installation (built from platform/calico/values.yaml)
helm install calico projectcalico/tigera-operator --version v3.33.1 \
  --namespace tigera-operator --create-namespace -f platform/calico/values.yaml

kubectl get pods -n calico-system -w            # calico-node (1 per node) → Running
kubectl get nodes                               # Ready
kubectl get tigerastatus                        # AVAILABLE True
kubectl get installation default -o jsonpath='{.spec.calicoNetwork.ipPools[*].cidr}{"\n"}'   # 10.244.0.0/16
```

### 16.3 metrics-server and Traefik
```bash
# metrics-server: needed by kubectl top and the HPA (OpenShift ships it; kind doesn't)
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm install metrics-server metrics-server/metrics-server --version 3.14.0 \
  --namespace kube-system -f platform/metrics-server/values.yaml
kubectl top nodes            # ⚠️ on kind each node reports the WHOLE VM as capacity, so % is misleading

# Traefik: the ingress controller (local equivalent of the OpenShift router)
helm repo add traefik https://traefik.github.io/charts
helm install traefik traefik/traefik --version 43.0.0 --namespace traefik --create-namespace \
  -f platform/traefik/values.yaml --dry-run=server     # validate against the chart's schema first
helm install traefik traefik/traefik --version 43.0.0 --namespace traefik --create-namespace \
  -f platform/traefik/values.yaml
kubectl get ingressclass                               # traefik → use in ingressClassName
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/   # 404 = Traefik reached, no rule yet
```
Why ingress-nginx isn't used: the Kubernetes project retired it (maintenance ended March 2026). Its successor direction is **Gateway API** (Stage 2+ with Istio).

| Exposure | Defined on | Opens | Used here |
|---|---|---|---|
| ClusterIP | Service | nothing (in-cluster only) | all app Services, Traefik's Service |
| hostPort | Pod | the pod's own node | Traefik 80/443 on the control plane (mapped to the Mac by kind) |
| NodePort | Service | 30000–32767 on every node | — |
| LoadBalancer | Service | a cloud LB (stays `<pending>` on kind) | — (likely what fronts the OpenShift router on ROSA) |

**Scheduling:** `nodeSelector` = *must* run on matching nodes; `toleration` = *allowed* on a tainted node. Traefik needs both to land on the control plane.
**DaemonSet vs Deployment:** a DaemonSet runs 1 pod **per node** (calico-node, kube-proxy); a Deployment runs N replicas anywhere (metrics-server, Traefik, CoreDNS, operators).

### 16.4 Deploy the Bookstore
```bash
kubectl config current-context                                   # kind-bookstore
kubectl config set-context --current --namespace=bookstore       # default namespace (like oc project)

# 1. Namespace + secrets (not in Git, applied by hand; Vault + ESO later)
kubectl apply -f deploy/overlays/local/namespace.yaml
kubectl apply -f deploy/base/postgres/secret.yaml -n bookstore
kubectl apply -f deploy/base/mongo/secret.yaml    -n bookstore

# 2. The app (everything except the migration Job)
kubectl apply -k deploy/overlays/local --dry-run=server
kubectl apply -k deploy/overlays/local
kubectl get pods -w              # API may restart a few times until Mongo is up (see §11)

# 3. Migration Job (after the DBs are Ready). Its own entry point: timing + Jobs are immutable
kubectl apply -k deploy/overlays/local/migrate
kubectl logs job/db-migrate

# 4. Test
curl -s http://bookstore.localhost/api/books                     # *.localhost → 127.0.0.1, no hosts file needed
```
Open **http://bookstore.localhost**.

**Why the ingress policy lives in the overlay:** *which* ingress controller lets traffic in is cluster-specific (Traefik here, the OpenShift router on OpenShift, the Istio gateway in Stage 2), so the policy sits next to the Ingress it serves. The base keeps `default-deny-ingress` + the app-internal allows.

### 16.5 Concepts met here
- **CRD** = a new object type the API server accepts (like loading an LDAP **schema**). A **CR** is one object of that type (like an LDAP **entry**). On its own it's just data.
- **Operator** = a pod with RBAC that **watches** CRs and **reconciles** (makes reality match the spec), level-triggered. The tigera-operator reads `Installation "default"` (Helm rendered it from `values.yaml`) and builds `calico-system`. If the operator dies, Calico keeps running; only repairs and upgrades stop.
- **The pod start-up relay:** helm → API server → Deployment controller → ReplicaSet controller → scheduler → kubelet → **CRI** → containerd → runc. Control-plane components are **static pods** from `/etc/kubernetes/manifests` on the control-plane node.
- **Plugs:** CRI (containers: containerd on kind, **CRI-O** on OpenShift), CNI (network: Calico here, OVN-Kubernetes on OpenShift), CSI (storage).

| Calico pod | Job |
|---|---|
| tigera-operator | Builds and maintains everything below |
| calico-node (DaemonSet) | Per-node networking + policy enforcement (Felix) |
| calico-typha | Cache between the API server and calico-node |
| calico-kube-controllers | Housekeeping (IPAM cleanup, sync) |
| calico-apiserver | Serves the `projectcalico.org/v3` API |
| goldmane / whisker | Flow-log aggregator / flow-log web UI |

### 16.6 Delete / rebuild
```bash
kind delete cluster --name bookstore            # everything gone in seconds; recreate with 16.1–16.2
```
