# ocp-lab: learning Kubernetes and OpenShift by building a real app

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
ocp-lab/
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
└── deploy/                      KUBERNETES YAML (how it runs); one folder per component
    ├── postgres/                secret(.example).yaml, service.yaml (headless), statefulset.yaml
    ├── mongo/                   secret(.example).yaml, service.yaml (headless), statefulset.yaml
    ├── migrate/                 job.yaml
    ├── api/                     deployment.yaml, service.yaml, hpa.yaml
    ├── nginx/                   configmap-content.yaml, configmap-proxy.yaml, deployment.yaml, service.yaml, ingress.yaml
    ├── backup/                  pvc.yaml, cronjob.yaml, restore-job.yaml (manual, NOT in kustomization)
    └── policies/                default-deny-ingress.yaml, allow-*.yaml
```

**Rules used in this repo**
- `app/` = code. `deploy/` = YAML. Never mix them.
- **Every `deploy/<component>/` folder has a `kustomization.yaml`** listing exactly which files to apply. Apply with **`-k`** (not `-f`).
- **Real secrets are never committed.** `secret.yaml` is in `.gitignore`; only `secret.example.yaml` (placeholders) is in Git.
- **Standard Kubernetes first.** OpenShift-only pieces are kept to a minimum (for example, one annotation on the Ingress) so the same YAML runs on kind/minikube/k3s.

> 🔜 **Planned change:** this will become `deploy/base/` + `deploy/overlays/{openshift,local}/` (Kustomize overlays) before moving to a local cluster. This section will be updated then.

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

> **Order matters:** secrets → databases → migrations → API → nginx/ingress → backup → network policies.
> Every `kubectl` command below also works with `oc`.
> **Always dry-run first:** `kubectl apply -k <folder> --dry-run=server`

```bash
git clone https://github.com/jyotirbhandari/ocp-lab.git
cd ocp-lab
```

### Step 1: Secrets (credentials for the databases)
**Concept:** a Secret keeps passwords out of the YAML that's in Git. Pods read them as environment variables. (Base64 is **not** encryption; Vault comes later.)
```bash
cp deploy/postgres/secret.example.yaml deploy/postgres/secret.yaml
cp deploy/mongo/secret.example.yaml    deploy/mongo/secret.yaml
# edit both files: replace CHANGE_ME with real passwords
git status        # secret.yaml must NOT appear (it's gitignored)
```
> ℹ️ The postgres/mongo `kustomization.yaml` currently list `secret.yaml`, so `-k` applies them automatically and **fails if the file is missing**. This will change before Argo CD (Git won't contain the secret).

### Step 2: PostgreSQL (StatefulSet + PVC + headless Service)
**Concept:** a **StatefulSet** gives the database a stable name (`postgres-0`) and **its own disk** (PVC `data-postgres-0`) that survives pod restarts. A **headless Service** (`clusterIP: None`) gives it a DNS name: `postgres`.
```bash
kubectl apply -k deploy/postgres/ --dry-run=server
kubectl apply -k deploy/postgres/
kubectl get pvc,pods -l app=postgres -w     # PVC Pending → Bound once the pod starts (WaitForFirstConsumer)
```

### Step 3: MongoDB
Same pattern as Postgres; different image, port (27017) and data path (`/data/db`).
```bash
kubectl apply -k deploy/mongo/
kubectl get pods -l app=mongo -w            # wait for 1/1
kubectl exec mongo-0 -- id                  # random UID assigned by OpenShift
```

### Step 4: Migration Job (schema + seed data)
**Concept:** a **Job** runs to completion. It uses the **same API image** with a different command (`node src/migrate.js`). Exit code 0 = success, 1 = retry (up to `backoffLimit`). A `schema_migrations` table makes it **safe to re-run**.
```bash
kubectl apply -k deploy/migrate/
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
kubectl apply -k deploy/api/
kubectl get pods -l app=api -w              # 0/1 → 1/1 once readyz passes
kubectl get hpa api                         # cpu: 4%/60%, REPLICAS 2
```

### Step 6: nginx + Ingress (public URL)
**Concept:** nginx serves `index.html` and forwards `/api/` to the `api` Service. The UBI nginx image loads extra config from `/opt/app-root/etc/nginx.default.d/*.conf`, so the proxy rule is mounted there from a ConfigMap. The **Ingress** is standard Kubernetes; OpenShift turns it into a Route.

⚠️ **Edit the host first:** `deploy/nginx/ingress.yaml` → `host: bookstore-<your-namespace>.apps.<your-cluster-domain>` (find your domain in the console URL).
```bash
kubectl apply -k deploy/nginx/
kubectl get ingress bookstore
oc get route                                # auto-created route, TERMINATION: edge
```
Open `https://bookstore-<namespace>.apps.<cluster-domain>`. You should see the Bookstore with 3 books.

### Step 7: Backups (PVC + CronJob)
**Concept:** a **CronJob** creates a Job on a schedule (`0 2 * * *` = 02:00 **UTC**). It runs `pg_dump` (same major version as the server) into a **separate PVC**.
```bash
kubectl apply -k deploy/backup/
kubectl get cronjob pg-backup
```
Test it right away (see [§9.2](#92-backups-and-restore)).

### Step 8: Network policies
**Concept:** NetworkPolicies are a firewall for pods, based on labels. **Allows add up; there's no "deny" rule.** `default-deny-ingress` selects all pods and allows nothing, and the `allow-*` policies open only what's needed.
```bash
kubectl apply -k deploy/policies/ --dry-run=server
kubectl apply -k deploy/policies/
```
In the **sandbox**, you must also remove `allow-same-namespace`, or nothing is restricted. Follow [§9.4](#94-network-policies) (save a backup first, **after** applying our policies).

---

## 7. Daily start-up (after the sandbox idles)

The sandbox scales workloads to 0 after ~12h. Data (PVCs) is safe. Re-applying your files restores the replica counts, **in order**:
```bash
cd ocp-lab
kubectl get deploy,sts,pods,pvc                           # what's there?
kubectl get secret postgres-credentials mongo-credentials # should still exist

kubectl apply -k deploy/postgres/
kubectl apply -k deploy/mongo/
kubectl get pods -l 'app in (postgres,mongo)' -w          # wait for 1/1 on both

kubectl delete job db-migrate --ignore-not-found          # a Job can't be re-applied
kubectl apply -k deploy/migrate/
kubectl logs -f job/db-migrate                            # expect "skip" lines

kubectl apply -k deploy/api/
kubectl apply -k deploy/nginx/
kubectl get pods                                          # everything 1/1
```
**Why this order?** If the API starts before the DBs, `/api/readyz` fails and its pods stay `0/1` (not ready, but not broken). They become ready on their own once the DBs are up.

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
kubectl apply -k deploy/migrate/
kubectl logs job/db-migrate          # already-applied files print "skip"
kubectl exec postgres-0 -- psql -d bookstore -c 'SELECT * FROM schema_migrations;'
```
- To add a migration: create `app/api/migrations/003_<name>.sql` → push (CI builds a new image) → update the image tag in `deploy/migrate/job.yaml` and `deploy/api/deployment.yaml` → run the Job.
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

# 2. set BACKUP_FILE in deploy/backup/restore-job.yaml to the file from the backup logs
# 3. run the restore: applied with -f because it's NOT part of the kustomization
kubectl apply -f deploy/backup/restore-job.yaml
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
mkdir -p ~/ocp-lab-backups
kubectl get networkpolicy allow-same-namespace -o yaml > ~/ocp-lab-backups/allow-same-namespace.backup.yaml
kubectl delete networkpolicy allow-same-namespace
# re-run the tests above + refresh the website
```

**Restore it** (undo):
```bash
kubectl apply -f ~/ocp-lab-backups/allow-same-namespace.backup.yaml
```
> Keep the backup **outside** the repo (or add `*.backup.yaml` to `.gitignore`). It's sandbox-specific.

**Remove our policies** (everything back to open):
```bash
kubectl delete -k deploy/policies/
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
1. Checkout → Buildx → log in to GHCR with the built-in `GITHUB_TOKEN` (`permissions: packages: write`; no secrets to manage)
2. Tags: `sha-<short-commit>` (immutable, used in the YAML) + `latest`
3. Builds `linux/amd64` (sandbox nodes)

Check an image without pulling it:
```bash
oc image info ghcr.io/jyotirbhandari/bookstore-api:sha-<commit> --filter-by-os=linux/amd64
```
- `unknown/unknown` in the manifest list = a **build provenance attestation**, not an image.
- The package is public because it's linked to the public repo (inherited access).

**Deploying a new version:** update the `image:` tag in `deploy/api/deployment.yaml` (and `deploy/migrate/job.yaml`) → `kubectl apply -k`. (Argo CD will automate this later.)

> 🔜 Planned: add `linux/arm64` (multi-arch) for local clusters on Apple Silicon.

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
| Pod `Completed` + restarts with empty logs | `server.js` was missing `app.listen()` (file truncated) | Code review before the build | Keep files complete; `node --check` |
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
| NetworkPolicy | Pod firewall (L3/L4, label-based, additive) | `deploy/policies/` |
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
- [ ] Multi-arch image (`linux/amd64` + `linux/arm64`)
- [ ] Kustomize `base/` + `overlays/{openshift,local}`
- [ ] Secrets out of `kustomization.yaml`

**Local cluster (Colima + kind)**
- [ ] Stage 1: kind (multi-node) + **Calico** + metrics-server + ingress + Bookstore
- [ ] Stage 2: **Istio sidecar mode**: mTLS, AuthorizationPolicy, Prometheus, Grafana, Kiali, tracing, canary, fault injection
- [ ] Stage 3: **Istio ambient mode** (sidecar → ztunnel migration)
- [ ] Stage 4: **Cilium** (eBPF) + Hubble; compare with Istio
- [ ] Argo CD (GitOps) and Vault + External Secrets

---

## 15. Teardown

```bash
kubectl delete -k deploy/policies/
kubectl delete -k deploy/backup/
kubectl delete -k deploy/nginx/
kubectl delete -k deploy/api/
kubectl delete -k deploy/migrate/
kubectl delete -k deploy/mongo/
kubectl delete -k deploy/postgres/

# StatefulSet PVCs are NOT deleted automatically (on purpose: data safety).
kubectl get pvc
kubectl delete pvc data-postgres-0 data-mongo-0       # ⚠️ permanently deletes the data (ReclaimPolicy: Delete)
```
To restore the sandbox's default network behaviour, re-apply `allow-same-namespace` ([§9.4](#94-network-policies)).
