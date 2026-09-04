# NanoClaw Migration Guide

Generated: 2026-09-02
Upgraded: 2026-09-03
Base: 0bc082a17cad3064bd9af395a61f1db959b85c1d
HEAD at generation: 7e80d1fa
HEAD after upgrade: 09a779e1
Upstream target: upstream/main

## Tier

Complex (Tier 3) — 1,599 upstream commits, 98 local commits, 7 distinct customization areas.

## Migration Plan

### Order of Operations

1. **Apply skill branches** — iMessage comes from `upstream/channels`. WhatsApp is NOT on an upstream skill branch (it's from a separate `whatsapp/main` fork repo); copy source files manually.
2. **Validate skill merge** — build must pass before applying source customizations.
3. **Apply source customizations** — dashboard wiring, db export, agent-runner tool allowlist, Dockerfile changes.
4. **Copy behavior customizations** — chat-sdk-bridge logging, .env.example addition.
5. **Apply telemetry opt-out** — skill diagnostics files.
6. **Install packages** — all new npm deps.
7. **Final build + test**.

### Staging

- After skill merges: run `pnpm run build` to catch any conflicts early.
- After all source changes: run `pnpm run build && pnpm test` for full validation.
- Container Dockerfile changes require `./container/build.sh` after the host build passes.

### Risk Areas

- `src/index.ts` is heavily changed in v2.3 (breaking changes: async DB, new delivery loop). The dashboard wiring (step 7) must be re-added after seeing the new upstream structure.
- `src/db/index.ts` may have a completely different export surface in v2.3 (async DB driver migration). The `getMessagingGroupsByAgentGroup` export must be re-added to the new barrel.
- `container/Dockerfile` will be substantially different in v2.3. Apply pnpm9 pin and MCP tool installs onto the new Dockerfile rather than copying the old one.
- `container/agent-runner/src/providers/claude.ts` — tool allowlist pattern may have changed. Re-add Gmail + Calendar tools to whatever allowlist mechanism v2.3 uses.
- `src/dashboard-pusher.ts` — all internal import paths may need adjustment if v2.3 reorganized DB modules. Read the new module layout before copying.

### Breaking Changes to Handle First

Before reapplying any customization, read and follow these v2.3 migration docs (they exist in the upstream tree):

| Breaking Change | Doc |
|---|---|
| Async central DB (DbDriver) | `docs/central-db-async-migration.md` |
| Container runtime → `src/drivers/` | `bun scripts/detect-driver-migration.ts` |
| Agent mailbox seam | `docs/agent-mailbox-seam-migration.md` |
| Host lifecycle registry | `docs/host-lifecycle-migration.md` |
| Provider-agnostic memory | `/migrate-memory` per agent group |
| Agent templates → Plugin 1.0.0 | `docs/templates.md` |

---

## Applied Skills

- `add-imessage` — from `upstream/channels` branch (the iMessage adapter + Chat SDK bridge)
- `add-whatsapp` — NOT from an upstream skill branch; WhatsApp code was merged from `whatsapp/main` (a separate fork at `https://github.com/qwibitai/nanoclaw-whatsapp.git`). Must be copied from main tree manually.
- `add-dashboard` — from `upstream/skill/` (not applicable — skill only installs the package; the pusher file and wiring are local customizations documented below)

### Skill Reapplication

**iMessage:** Merge `upstream/channels` in the worktree:
```bash
cd "$WORKTREE" && git merge upstream/channels --no-edit
```
This will add `src/channels/imessage.ts`, `src/channels/chat-sdk-bridge.ts`, and register the import in `src/channels/index.ts`.

**WhatsApp:** No upstream skill branch. After the iMessage skill merge, manually copy these files from the main tree into the worktree:
- `src/channels/whatsapp.ts`
- `src/whatsapp-auth.ts`
- `setup/whatsapp-auth.ts`
- `setup/groups.ts`
Then add the whatsapp import to `src/channels/index.ts` (see Customization section below).

---

## Skill Interactions

**iMessage and WhatsApp both register in `src/channels/index.ts`:** After merging iMessage from `upstream/channels` and then copying WhatsApp files manually, `src/channels/index.ts` will need both imports. The iMessage merge will add its own import; the WhatsApp import must be added manually. No conflict — they use different channel type strings (`'imessage'` vs `'whatsapp'`).

**`src/channels/chat-sdk-bridge.ts`:** The iMessage adapter uses this bridge. The only local change is the logger level (`'silent'` → `'warn'`). This file will be brought in by the iMessage skill merge; apply the logger change after.

---

## Modifications to Applied Skills

### iMessage: Logger verbosity

**Intent:** Chat SDK bridge produces useful debug output when set to `warn` level; `silent` hides errors that help diagnose iMessage connectivity issues.

**Files:** `src/channels/chat-sdk-bridge.ts`

**How to apply:** (after `upstream/channels` merge)
Find the `createClient` or similar initialization call that passes a logger option. Change `logger: 'silent'` to `logger: 'warn'`.

### iMessage: Recovery scanner

**Intent:** When nanoclaw restarts or crashes, messages that arrived during downtime are missed because the Chat SDK bridge only sees live events. The recovery scanner polls `chat.db` (macOS Messages database) every 2 minutes and re-routes any messages that didn't make it to `inbound.db`.

**Files:** `src/channels/imessage.ts`

**How to apply:** The full recovery scanner is baked into `src/channels/imessage.ts`. After the iMessage skill merge brings in the base adapter, **replace the entire `src/channels/imessage.ts`** with the version from the main tree (which includes the recovery scanner). The file is 237 lines.

Key details in the recovery scanner:
- MAC_EPOCH = January 1, 2001 (Apple's base date for chat.db timestamps)
- Queries `chat.db` at `/Users/<username>/Library/Messages/chat.db`
- Runs every 2 minutes via `setInterval`
- Checks per-session `inbound.db` to avoid re-routing already-delivered messages
- Only enabled in `IMESSAGE_LOCAL=true` mode (default)
- Env vars: `IMESSAGE_ENABLED`, `IMESSAGE_LOCAL`, `IMESSAGE_SERVER_URL`, `IMESSAGE_API_KEY`

---

## Customizations

### WhatsApp: Register channel import

**Intent:** WhatsApp adapter must be imported in the channel barrel so it self-registers on startup.

**Files:** `src/channels/index.ts`

**How to apply:** Add to the imports (after any iMessage import from the skill merge):
```typescript
import './whatsapp.js';
```

### WhatsApp: Package dependencies

**Intent:** The Baileys-based WhatsApp adapter requires several packages not in upstream.

**Files:** `package.json` (and `pnpm-lock.yaml` after install)

**How to apply:** Run:
```bash
pnpm add @whiskeysockets/baileys@6.17.16 qrcode@1.5.4 qrcode-terminal@0.12.0 @types/qrcode@1.5.6
```

Note: `@whiskeysockets/baileys@6.17.16` is pinned to this exact version — the getPlatformId bug patch in `whatsapp.ts` is version-specific.

### WhatsApp: Auth env var in .env.example

**Intent:** Document the optional `ASSISTANT_HAS_OWN_NUMBER` env var.

**Files:** `.env.example`

**How to apply:** Add a line:
```
ASSISTANT_HAS_OWN_NUMBER=
```
(empty value = not set, adapter defaults to filtering self-messages)

### Dashboard: New pusher file

**Intent:** Collect NanoClaw runtime state (agent groups, sessions, channels, users, token usage, context windows, activity, messages) and POST JSON snapshots to the dashboard's `/api/ingest` endpoint every 60 seconds. Also tails the log file and pushes log lines to `/api/logs/push` every 2 seconds.

**Files:** `src/dashboard-pusher.ts` (new file, 580 lines)

**How to apply:** Copy `src/dashboard-pusher.ts` from the main tree into the worktree. **CRITICAL:** The import paths inside this file reference DB modules at paths specific to this install. After copying, verify all import paths against the v2.3 module layout. In this install the correct paths are:

```typescript
import { getDestinations, hasDestination } from './modules/agent-to-agent/db/agent-destinations.js';
import { getAgentGroupMembers } from './modules/permissions/db/agent-group-members.js';
import { getUserById } from './modules/permissions/db/users.js';
import { getUserRoles } from './modules/permissions/db/user-roles.js';
import { getUserDms } from './modules/permissions/db/user-dms.js';
```

If v2.3 has reorganized these modules (check `src/db/` and `src/modules/` in the worktree), update the import paths accordingly before building.

### Dashboard: Wire into host startup

**Intent:** Start the dashboard server and pusher at startup if `DASHBOARD_SECRET` is configured. Dashboard is optional — if the env var is absent, nanoclaw starts normally without it.

**Files:** `src/index.ts`

**How to apply:** In v2.3's `src/index.ts`, find the location of the host startup sequence (after delivery polls and host sweep are started, before the final "NanoClaw running" log). Add:

```typescript
  // Dashboard (optional)
  const dashboardEnv = readEnvFile(['DASHBOARD_SECRET', 'DASHBOARD_PORT']);
  const dashboardSecret = process.env.DASHBOARD_SECRET || dashboardEnv.DASHBOARD_SECRET;
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || dashboardEnv.DASHBOARD_PORT || '3100', 10);
  if (dashboardSecret) {
    const { startDashboard } = await import('@nanoco/nanoclaw-dashboard');
    const { startDashboardPusher } = await import('./dashboard-pusher.js');
    startDashboard({ port: dashboardPort, secret: dashboardSecret });
    startDashboardPusher({ port: dashboardPort, secret: dashboardSecret, intervalMs: 60000 });
  } else {
    log.info('Dashboard disabled (no DASHBOARD_SECRET)');
  }
```

Also ensure `readEnvFile` is imported at the top:
```typescript
import { readEnvFile } from './env.js';
```

Note: In v2.3, `src/index.ts` may be significantly restructured due to the async DB and host lifecycle registry breaking changes. Place this block at the equivalent "startup complete" position in whatever structure v2.3 uses.

### Dashboard: DB export

**Intent:** `dashboard-pusher.ts` uses `getMessagingGroupsByAgentGroup` to build the agent groups view (lists which messaging groups are wired to each agent group).

**Files:** `src/db/index.ts`

**How to apply:** Ensure `getMessagingGroupsByAgentGroup` is exported from `src/db/index.ts`. In this install, it's exported from `./messaging-groups.js`. Check whether it exists in v2.3's messaging-groups module; if yes, add the export. If the function was renamed or moved, use the equivalent.

```typescript
export { getMessagingGroupsByAgentGroup } from './messaging-groups.js';
```

### Dashboard: Package dependency

**Intent:** `@nanoco/nanoclaw-dashboard` provides the HTTP server that receives snapshots from the pusher and serves the web UI.

**Files:** `package.json`

**How to apply:**
```bash
pnpm add @nanoco/nanoclaw-dashboard@0.3.0
```

### Container: Pin pnpm to v9 and install MCP tools

**Intent:**
- pnpm v10+ changed `global-bin-dir` behavior in ways that break the Claude Agent SDK binary lookup inside containers. Pinning to v9 keeps the stable global binary path.
- Gmail and Google Calendar MCP servers are installed globally in the container so agents have access to email and calendar tools.

**Files:** `container/Dockerfile`

**How to apply:** In v2.3's Dockerfile, find the pnpm installation step. Replace `corepack enable` (or whatever the upstream uses) with a direct pnpm@9 install:
```dockerfile
RUN npm install -g pnpm@9
```

Then add MCP tool installations to the pnpm global install block:
```dockerfile
ARG GMAIL_MCP_VERSION=1.1.11
ARG CALENDAR_MCP_VERSION=2.6.1

RUN pnpm install -g \
    "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
    "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}" \
    "zod-to-json-schema@3.22.5"
```

Also ensure the claude-code install hook is called after installing `@anthropic-ai/claude-code`:
```dockerfile
RUN pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && \
    node "$(pnpm root -g)/@anthropic-ai/claude-code/install.cjs"
```

**Do NOT** add entries to `minimumReleaseAgeExclude` for these packages without explicit human approval (see CLAUDE.md supply chain security rules).

### Container: Agent runner tool allowlist for Gmail and Calendar

**Intent:** Gmail and Google Calendar MCP tools need to be in the agent runner's tool allowlist, otherwise the Claude Agent SDK will block them.

**Files:** `container/agent-runner/src/providers/claude.ts`

**How to apply:** Find the `TOOL_ALLOWLIST` array (or equivalent allowlist configuration) in this file. Add:
```typescript
'mcp__gmail__*',
'mcp__calendar__*',
```

If v2.3 changed the allowlist mechanism (check the file in the worktree before editing), apply to whatever the new equivalent is.

### Telemetry opt-out: Skill diagnostics files

**Intent:** PostHog analytics telemetry permanently disabled. User has opted out and does not want to be asked again.

**Files:**
- `.claude/skills/migrate-nanoclaw/diagnostics.md`
- `.claude/skills/update-nanoclaw/diagnostics.md`

**How to apply:** Replace the content of both files with:
```
# Diagnostics — opted out
```

Also ensure the `## Diagnostics` sections are removed from:
- `.claude/skills/migrate-nanoclaw/SKILL.md`
- `.claude/skills/update-nanoclaw/SKILL.md`

### Telemetry opt-out: GitHub workflow

**Intent:** Automated token counting workflow that sent analytics to PostHog is permanently deleted.

**Files:** `.github/workflows/update-tokens.yml`

**How to apply:** Delete the file:
```bash
rm .github/workflows/update-tokens.yml
```

---

## Post-Migration Tasks

After the migration completes and the build passes:

### 1. Run /migrate-memory for each agent group

v2.3 changed the memory format from `CLAUDE.local.md` to the OKF `memory/` directory structure. Run `/migrate-memory` for each agent group:
- `dm-with-pooh-bear`
- `kuma-health`

### 2. Rebuild container image

```bash
./container/build.sh
```

The Dockerfile changes (pnpm9 pin, MCP tools) require a fresh container build.

### 3. Restart nanoclaw

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 4. Verify dashboard

```bash
curl -s -H "Authorization: Bearer nc-acc14997f84d4bb191e86be6589452f4" http://localhost:3100/api/overview
```

### 5. Send test iMessage

Send a test iMessage to Pooh Bear. The container should spawn and respond.

### 6. WhatsApp re-authentication

WhatsApp was logged out (401) before the migration. After the migration, re-authenticate:
```bash
npx tsx setup/whatsapp-auth.ts --method qr-browser
```

---

## Rollback

```bash
git reset --hard pre-migrate-<hash>-<timestamp>
# Restore data if needed:
rsync -a ~/nanoclaw-backup-20260902-211800/groups/ groups/
rsync -a ~/nanoclaw-backup-20260902-211800/data/ data/
cp ~/nanoclaw-backup-20260902-211800/.env .env
```
