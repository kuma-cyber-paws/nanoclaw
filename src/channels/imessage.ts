/**
 * iMessage channel adapter (v2) — uses Chat SDK bridge.
 * Supports local mode (macOS Full Disk Access) and remote mode (Photon API).
 * Self-registers on import.
 *
 * Recovery scanner: runs every 2 minutes in local mode. Queries chat.db for
 * messages from wired iMessage chats in the last 2 hours and re-routes any
 * that never reached an inbound.db (dropped by seenMessageIds after a failed
 * dispatch, or sent while the process was down).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { createiMessageAdapter } from 'chat-adapter-imessage';

import { DATA_DIR } from '../config.js';
import { getDb } from '../db/connection.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { routeInbound } from '../router.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const IMESSAGE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '\\b{name}\\b', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

// ---------------------------------------------------------------------------
// Recovery scanner
// ---------------------------------------------------------------------------

const MAC_EPOCH_MS = new Date('2001-01-01T00:00:00Z').getTime();
const RECOVERY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const RECOVERY_LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours

let scanCount = 0;

// In-process dedup: GUIDs routed since this process started.
// Prevents re-routing on every scanner tick while the session DB
// is still being committed, or when old sessions no longer exist
// in the sessions table (so the inbound.db check can't fire).
const routedInProcess = new Set<string>();
export { routedInProcess as _routedInProcessForTesting };

export async function _runRecoveryScanForTesting(): Promise<void> {
  return runRecoveryScan();
}

async function runRecoveryScan(): Promise<void> {
  const run = ++scanCount;
  const chatDbPath = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  if (!fs.existsSync(chatDbPath)) {
    log.warn('iMessage recovery: chat.db not found', { run, chatDbPath });
    return;
  }

  const centralDb = getDb();
  const groups = await centralDb.all<{ id: string; platform_id: string }>(
    `SELECT DISTINCT mg.id, mg.platform_id
     FROM messaging_groups mg
     JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
     WHERE mg.channel_type = 'imessage' AND mg.denied_at IS NULL`,
  );

  if (groups.length === 0) {
    log.debug('iMessage recovery: no wired iMessage groups', { run });
    return;
  }

  // cutoff in chat.db nanosecond epoch (2001-01-01 base)
  const cutoffNs = (Date.now() - RECOVERY_LOOKBACK_MS - MAC_EPOCH_MS) * 1e6;

  let totalSeen = 0;
  let totalAlreadyRouted = 0;
  let totalRerouted = 0;

  let chatDb: Database.Database | null = null;
  try {
    chatDb = new Database(chatDbPath, { readonly: true });

    for (const mg of groups) {
      const chatIdentifier = mg.platform_id.replace(/^imessage:/, '');

      const messages = chatDb
        .prepare(
          `SELECT m.guid, m.text, m.date, h.id AS sender_id
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.rowid
           JOIN chat c ON c.rowid = cmj.chat_id
           LEFT JOIN handle h ON h.rowid = m.handle_id
           WHERE c.chat_identifier = ?
             AND m.is_from_me = 0
             AND m.date >= ?
           ORDER BY m.date ASC`,
        )
        .all(chatIdentifier, cutoffNs) as Array<{
        guid: string;
        text: string | null;
        date: number;
        sender_id: string | null;
      }>;

      totalSeen += messages.length;

      if (messages.length === 0) continue;

      // All sessions for this messaging group (to detect already-routed GUIDs)
      const sessions = await centralDb.all<{ id: string; agent_group_id: string }>(
        'SELECT id, agent_group_id FROM sessions WHERE messaging_group_id = ?',
        mg.id,
      );

      for (const msg of messages) {
        // Skip attachment-only messages — no text means the engage-pattern
        // ('.') drops them silently, so they'll never appear in inbound.db
        // and the dedup check below can never confirm them as already-routed.
        // Without this skip, attachment GUIDs loop every 2 minutes forever.
        if (!msg.text?.trim()) continue;

        // In-process dedup: skip GUIDs we already routed this run so the
        // scanner doesn't re-route on every tick while commits are in flight.
        if (routedInProcess.has(msg.guid)) {
          totalAlreadyRouted++;
          continue;
        }

        // Check every known session's inbound.db for this GUID
        let alreadyRouted = false;
        for (const sess of sessions) {
          const inboundPath = path.join(DATA_DIR, 'v2-sessions', sess.agent_group_id, sess.id, 'inbound.db');
          if (!fs.existsSync(inboundPath)) continue;
          let inDb: Database.Database | null = null;
          try {
            inDb = new Database(inboundPath, { readonly: true });
            inDb.pragma('busy_timeout = 3000');
            const row = inDb.prepare('SELECT 1 FROM messages_in WHERE id LIKE ? LIMIT 1').get(`${msg.guid}:%`);
            if (row) {
              alreadyRouted = true;
              break;
            }
          } catch (err) {
            // inbound.db may be temporarily locked (SQLITE_BUSY) or
            // mid-schema-init. Treat as already-routed to avoid duplicate
            // delivery — a locked DB means the session is active and the
            // message was very likely delivered.
            log.debug('iMessage recovery: could not read inbound.db, treating as routed', {
              run,
              guid: msg.guid,
              inboundPath,
              err,
            });
            alreadyRouted = true;
            break;
          } finally {
            inDb?.close();
          }
        }

        if (alreadyRouted) {
          totalAlreadyRouted++;
          continue;
        }

        const senderPhone = msg.sender_id ?? chatIdentifier;
        const senderId = `imessage:${senderPhone}`;
        const isGroup = chatIdentifier.includes(';-;');
        const timestamp = new Date(MAC_EPOCH_MS + msg.date / 1e6).toISOString();

        log.info('iMessage recovery: routing missed message', {
          run,
          guid: msg.guid,
          chatIdentifier,
          messagingGroupId: mg.id,
          timestamp,
        });

        await routeInbound({
          channelType: 'imessage',
          platformId: mg.platform_id,
          threadId: null,
          message: {
            id: msg.guid,
            kind: 'chat-sdk',
            content: JSON.stringify({
              text: msg.text ?? '',
              senderId,
              sender: senderPhone,
              senderName: senderPhone,
              author: {
                userId: senderId,
                fullName: senderPhone,
                userName: senderPhone,
              },
            }),
            timestamp,
            isMention: !isGroup,
            isGroup,
          },
        });

        routedInProcess.add(msg.guid);
        totalRerouted++;
      }
    }
  } catch (err) {
    log.warn('iMessage recovery scan error', { run, err });
  } finally {
    chatDb?.close();
  }

  log.debug('iMessage recovery scan complete', {
    run,
    groups: groups.length,
    seen: totalSeen,
    alreadyRouted: totalAlreadyRouted,
    rerouted: totalRerouted,
  });
}

function startRecoveryScanner(): NodeJS.Timeout {
  let scanning = false;
  return setInterval(() => {
    if (scanning) return;
    scanning = true;
    runRecoveryScan().finally(() => {
      scanning = false;
    });
  }, RECOVERY_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

registerChannelAdapter('imessage', {
  factory: () => {
    const env = readEnvFile(['IMESSAGE_ENABLED', 'IMESSAGE_LOCAL', 'IMESSAGE_SERVER_URL', 'IMESSAGE_API_KEY']);
    const isLocal = env.IMESSAGE_LOCAL !== 'false';
    if (isLocal && !env.IMESSAGE_ENABLED) return null;
    if (!isLocal && !env.IMESSAGE_SERVER_URL) return null;
    const rawAdapter = createiMessageAdapter({
      local: isLocal,
      serverUrl: env.IMESSAGE_SERVER_URL,
      apiKey: env.IMESSAGE_API_KEY,
    });
    // Polyfill channelIdFromThreadId (community adapter doesn't implement it)
    const imessageAdapter = Object.assign(rawAdapter, {
      channelIdFromThreadId: (threadId: string) => threadId,
    });
    const bridge = createChatSdkBridge({ adapter: imessageAdapter, concurrency: 'concurrent', supportsThreads: false });

    // Wrap setup/teardown to manage the recovery scanner lifecycle.
    // Only runs in local mode — remote/Photon mode has no chat.db to query.
    if (isLocal) {
      let timer: NodeJS.Timeout | null = null;
      const originalSetup = bridge.setup.bind(bridge);
      const originalTeardown = bridge.teardown.bind(bridge);
      bridge.setup = async (hostConfig) => {
        await originalSetup(hostConfig);
        timer = startRecoveryScanner();
      };
      bridge.teardown = async () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        await originalTeardown();
      };
    }

    return bridge;
  },
  defaults: IMESSAGE_DEFAULTS,
});
