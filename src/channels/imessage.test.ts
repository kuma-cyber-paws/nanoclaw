/**
 * iMessage recovery scanner unit tests.
 *
 * Exercises the dedup logic in runRecoveryScan via its exported test handle.
 * All I/O boundaries are mocked: chat.db (better-sqlite3), inbound.db, the
 * central DB, and routeInbound.
 *
 * Note: MockDatabase MUST use a regular `function` (not an arrow function)
 * because vitest skips the implementation for `new` calls when an arrow
 * function is used, returning an empty object that throws on method access.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── hoisted mocks (available inside vi.mock factories at hoist time) ──────────

const { mockChatDbAll, mockInboundGet, MockDatabase, mockCentralAll, mockRouteInbound, mockExistsSync } = vi.hoisted(
  () => {
    const mockChatDbAll = vi.fn().mockReturnValue([]);
    const mockInboundGet = vi.fn().mockReturnValue(null);

    // Must use a regular `function` (not an arrow) so vitest calls it correctly
    // when `new Database(path)` is used — arrow functions cause vitest to skip
    // the implementation and return an empty object, breaking .pragma() etc.
    const MockDatabase = vi.fn(function (this: unknown, filePath: string) {
      if (filePath.endsWith('chat.db')) {
        return { prepare: vi.fn(() => ({ all: mockChatDbAll })), close: vi.fn() };
      }
      // inbound.db
      return {
        prepare: vi.fn(() => ({ get: mockInboundGet })),
        pragma: vi.fn(),
        close: vi.fn(),
      };
    });

    const mockCentralAll = vi.fn().mockResolvedValue([]);
    const mockRouteInbound = vi.fn().mockResolvedValue(undefined);
    const mockExistsSync = vi.fn().mockReturnValue(true);

    return { mockChatDbAll, mockInboundGet, MockDatabase, mockCentralAll, mockRouteInbound, mockExistsSync };
  },
);

// ── vi.mock declarations ───────────────────────────────────────────────────────

vi.mock('chat-adapter-imessage', () => ({ createiMessageAdapter: vi.fn() }));
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: vi.fn(() => ({ setup: vi.fn(), teardown: vi.fn() })),
}));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({ DATA_DIR: '/data' }));
vi.mock('../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

vi.mock('../db/connection.js', () => ({
  getDb: () => ({ all: mockCentralAll }),
}));

vi.mock('../router.js', () => ({
  routeInbound: (...args: unknown[]) => mockRouteInbound(...args),
}));

vi.mock('better-sqlite3', () => ({ default: MockDatabase }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, default: { ...actual, existsSync: mockExistsSync } };
});

// ── module under test ─────────────────────────────────────────────────────────

import { _routedInProcessForTesting, _runRecoveryScanForTesting } from './imessage.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const MAC_EPOCH_MS = new Date('2001-01-01T00:00:00Z').getTime();

function toMacNs(date: Date): number {
  return (date.getTime() - MAC_EPOCH_MS) * 1e6;
}

function makeMsg(overrides: Partial<{ guid: string; text: string | null; date: number; sender_id: string }> = {}) {
  return {
    guid: 'GUID-001',
    text: 'hello',
    date: toMacNs(new Date(Date.now() - 5 * 60 * 1000)), // 5 min ago, within 2-hour lookback
    sender_id: '+15550001111',
    ...overrides,
  };
}

function setupOneGroup(msgs: ReturnType<typeof makeMsg>[]) {
  mockCentralAll
    .mockResolvedValueOnce([{ id: 'mg-1', platform_id: 'imessage:+15550001111' }]) // groups
    .mockResolvedValueOnce([{ id: 'sess-1', agent_group_id: 'ag-1' }]); // sessions
  mockChatDbAll.mockReturnValue(msgs);
}

// ── test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _routedInProcessForTesting.clear();

  mockExistsSync.mockReturnValue(true);
  mockCentralAll.mockResolvedValue([]);
  mockChatDbAll.mockReturnValue([]);
  mockInboundGet.mockReturnValue(null);
  mockRouteInbound.mockResolvedValue(undefined);

  // Re-establish MockDatabase as a regular function (not arrow) after clearAllMocks
  MockDatabase.mockImplementation(function (this: unknown, filePath: string) {
    if (filePath.endsWith('chat.db')) {
      return { prepare: vi.fn(() => ({ all: mockChatDbAll })), close: vi.fn() };
    }
    return {
      prepare: vi.fn(() => ({ get: mockInboundGet })),
      pragma: vi.fn(),
      close: vi.fn(),
    };
  });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('recovery scanner — no groups wired', () => {
  it('exits early without opening chat.db', async () => {
    mockCentralAll.mockResolvedValue([]);
    await _runRecoveryScanForTesting();
    expect(MockDatabase).not.toHaveBeenCalled();
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });
});

describe('recovery scanner — null/empty text messages (Bug 1: infinite re-route loop)', () => {
  it('does not route a null-text (attachment-only) message', async () => {
    setupOneGroup([makeMsg({ guid: 'ATTACH-1', text: null })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).not.toHaveBeenCalled();
    expect(_routedInProcessForTesting.has('ATTACH-1')).toBe(false);
  });

  it('does not route an empty-string text message', async () => {
    setupOneGroup([makeMsg({ guid: 'EMPTY-1', text: '' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('does not route a whitespace-only text message', async () => {
    setupOneGroup([makeMsg({ guid: 'WS-1', text: '   \t\n' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('routes a message with real text content', async () => {
    setupOneGroup([makeMsg({ guid: 'TEXT-1', text: 'hi there' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).toHaveBeenCalledOnce();
    expect(_routedInProcessForTesting.has('TEXT-1')).toBe(true);
  });
});

describe('recovery scanner — in-process dedup (Bug 1: re-routes on every tick)', () => {
  it('skips a GUID already in routedInProcess (simulates second scan tick)', async () => {
    _routedInProcessForTesting.add('GUID-001');
    setupOneGroup([makeMsg({ guid: 'GUID-001', text: 'hello' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('adds the GUID to routedInProcess after successful routing', async () => {
    setupOneGroup([makeMsg({ guid: 'FRESH-1', text: 'fresh message' })]);
    mockInboundGet.mockReturnValue(null); // not in inbound.db
    await _runRecoveryScanForTesting();
    expect(_routedInProcessForTesting.has('FRESH-1')).toBe(true);
  });

  it('Set persists across multiple scan ticks — GUIDs are never re-routed', async () => {
    setupOneGroup([makeMsg({ guid: 'TICK-1', text: 'message' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).toHaveBeenCalledOnce();

    // Second tick: same GUID, must not re-route
    setupOneGroup([makeMsg({ guid: 'TICK-1', text: 'message' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).toHaveBeenCalledOnce(); // still only one total
  });
});

describe('recovery scanner — SQLITE_BUSY treated as already-routed (Bug 2: re-route on restart)', () => {
  it('does not route when inbound.db throws on read', async () => {
    setupOneGroup([makeMsg({ guid: 'LOCKED-1', text: 'message' })]);

    // Override to make inbound.db throw SQLITE_BUSY on prepare().get()
    MockDatabase.mockImplementation(function (this: unknown, filePath: string) {
      if (filePath.endsWith('chat.db')) {
        return { prepare: vi.fn(() => ({ all: mockChatDbAll })), close: vi.fn() };
      }
      return {
        prepare: vi.fn(() => ({
          get: vi.fn(() => {
            throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
          }),
        })),
        pragma: vi.fn(),
        close: vi.fn(),
      };
    });

    await _runRecoveryScanForTesting();

    // Locked DB = session is active = message was likely delivered → don't re-route
    expect(mockRouteInbound).not.toHaveBeenCalled();
    // GUID is NOT in routedInProcess because it was skipped (not routed)
    expect(_routedInProcessForTesting.has('LOCKED-1')).toBe(false);
  });
});

describe('recovery scanner — chat.db not found', () => {
  it('exits early without opening any db when chat.db is missing', async () => {
    // existsSync fires BEFORE the groups query — no centralAll mock needed here;
    // adding one would leave an unconsumed `once` that poisons subsequent tests.
    mockExistsSync.mockReturnValue(false);
    await _runRecoveryScanForTesting();
    expect(MockDatabase).not.toHaveBeenCalled();
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });
});

describe('recovery scanner — outer catch (chat.db open throws)', () => {
  it('swallows errors from opening chat.db without crashing', async () => {
    // The outer try fires AFTER the groups query but BEFORE the sessions query —
    // only one `once` is consumed, so no sessions mock is added here.
    mockCentralAll.mockResolvedValueOnce([{ id: 'mg-1', platform_id: 'imessage:+15550001111' }]);
    MockDatabase.mockImplementation(function (this: unknown, filePath: string) {
      if (filePath.endsWith('chat.db')) throw new Error('disk I/O error');
      return { prepare: vi.fn(() => ({ get: mockInboundGet })), pragma: vi.fn(), close: vi.fn() };
    });
    await expect(_runRecoveryScanForTesting()).resolves.toBeUndefined();
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });
});

describe('recovery scanner — sender_id fallback and group chat detection', () => {
  it('falls back to chatIdentifier as senderId when sender_id is null', async () => {
    mockCentralAll
      .mockResolvedValueOnce([{ id: 'mg-1', platform_id: 'imessage:+15550001111' }])
      .mockResolvedValueOnce([]);
    mockChatDbAll.mockReturnValue([makeMsg({ guid: 'NULL-SENDER', sender_id: null as unknown as string })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).toHaveBeenCalledOnce();
    const payload = mockRouteInbound.mock.calls[0][0];
    const content = JSON.parse(payload.message.content);
    // sender_id null → falls back to chatIdentifier (+15550001111)
    expect(content.senderId).toBe('imessage:+15550001111');
  });

  it('sets isGroup=true and isMention=false for group chats (platform_id contains ;-;)', async () => {
    const groupPlatformId = 'imessage:chat123456789;-;+15550001111';
    mockCentralAll.mockResolvedValueOnce([{ id: 'mg-grp', platform_id: groupPlatformId }]).mockResolvedValueOnce([]);
    mockChatDbAll.mockReturnValue([makeMsg({ guid: 'GROUP-1', text: 'hey group' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).toHaveBeenCalledOnce();
    const payload = mockRouteInbound.mock.calls[0][0];
    expect(payload.message.isGroup).toBe(true);
    expect(payload.message.isMention).toBe(false);
  });
});

describe('recovery scanner — no sessions for group (empty sessions list)', () => {
  it('routes when there are no sessions to check inbound.db against', async () => {
    mockCentralAll
      .mockResolvedValueOnce([{ id: 'mg-1', platform_id: 'imessage:+15550001111' }])
      .mockResolvedValueOnce([]); // no sessions → alreadyRouted stays false
    mockChatDbAll.mockReturnValue([makeMsg({ guid: 'NO-SESS-1', text: 'hello' })]);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).toHaveBeenCalledOnce();
    expect(_routedInProcessForTesting.has('NO-SESS-1')).toBe(true);
  });
});

describe('recovery scanner — normal dedup via inbound.db', () => {
  it('skips a GUID found in inbound.db', async () => {
    setupOneGroup([makeMsg({ guid: 'FOUND-1', text: 'already delivered' })]);
    mockInboundGet.mockReturnValue({ 1: 1 }); // row found → already routed
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('routes a GUID not found in any inbound.db', async () => {
    setupOneGroup([makeMsg({ guid: 'MISSED-1', text: 'missed during downtime' })]);
    mockInboundGet.mockReturnValue(null);
    await _runRecoveryScanForTesting();
    expect(mockRouteInbound).toHaveBeenCalledOnce();
    expect(mockRouteInbound.mock.calls[0][0]).toMatchObject({
      channelType: 'imessage',
      message: expect.objectContaining({ id: 'MISSED-1' }),
    });
  });

  it('skips the inbound.db check when the file does not exist, and still routes', async () => {
    setupOneGroup([makeMsg({ guid: 'NO-DB-1', text: 'message' })]);

    // chat.db exists; inbound.db for the session does not
    mockExistsSync.mockImplementation((p: unknown) => (p as string).endsWith('chat.db'));

    await _runRecoveryScanForTesting();
    // No sessions have a live inbound.db → alreadyRouted stays false → route
    expect(mockRouteInbound).toHaveBeenCalledOnce();
  });
});
