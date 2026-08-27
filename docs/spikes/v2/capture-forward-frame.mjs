/**
 * Spike #22: raw `history` + `message_info` frame for a FORWARDED message.
 *
 * Unlike the poll spikes, this one does not drive the browser: it raises the very same
 * cookie session from the Playwright profile through the project's own auth stack
 * (CookieAuthProvider -> PlaywrightProfile) and issues the WS call directly. Same
 * session source, one narrow request, no UI clicks.
 *
 * Privacy: the RAW dump is written to a scratch file OUTSIDE the repo. Only a
 * value-free SHAPE (key names, types, array lengths) is printed to stdout, so the
 * captured facts can be quoted into the spike write-up without carrying content.
 *
 * env: CHAT_ID=<chat id>  TS=<timestamp mcs>  RAW_OUT=<abs path for raw json>
 * run: node docs/spikes/v2/capture-forward-frame.mjs   (needs `npm run build` first)
 */
import fs from 'node:fs';
import { CookieAuthProvider } from '../../../dist/auth/CookieAuthProvider.js';
import { PlaywrightProfile } from '../../../dist/auth/PlaywrightProfile.js';
import { loadConfig } from '../../../dist/config/loadConfig.js';
import { MessengerWsClient } from '../../../dist/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../../dist/util/logger.js';

const CHAT_ID = process.env.CHAT_ID;
const TS = BigInt(process.env.TS || '0');
const RAW_OUT = process.env.RAW_OUT || '/tmp/forward-frame-raw.json';

if (!CHAT_ID || TS === 0n) {
  throw new Error('CHAT_ID and TS are required');
}

/** Value-free shape: key names, types and array lengths only. Content never leaks */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array(0)';
    return { [`array(${value.length})`]: shape(value[0], depth + 1) };
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = shape(value[key], depth + 1);
    return out;
  }
  if (typeof value === 'string') return `string(len=${value.length})`;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return typeof value === 'boolean' ? `bool:${value}` : typeof value;
}

const config = loadConfig();
const logger = createLogger({ bindings: { component: 'spike-forward' } });
const profile = new PlaywrightProfile({ profileDir: config.paths.profileDir, logger });
const auth = new CookieAuthProvider({
  profile,
  apiUrl: config.protocol.apiUrl,
  csrfTokenUrl: config.protocol.csrfTokenUrl,
  logger,
});
const ws = new MessengerWsClient({
  auth,
  xivaUrl: config.protocol.xivaUrl,
  xivaServiceName: config.protocol.xivaServiceName,
  logger,
});

const raw = {};

/* Narrow window: MinTimestamp/MaxTimestamp are both EXCLUSIVE, so +-1 mcs isolates one message */
raw.history = await ws.request('history', {
  ChatId: CHAT_ID,
  Limit: 1,
  MinTimestamp: Number(TS - 1n),
  MaxTimestamp: Number(TS + 1n),
});

raw.messageInfo = await ws.request('message_info', {
  ChatId: CHAT_ID,
  Timestamp: Number(TS),
});

fs.writeFileSync(RAW_OUT, JSON.stringify(raw, null, 2));
console.log('[raw written]', RAW_OUT);
console.log(JSON.stringify(shape(raw), null, 2));

/* Top-level sibling key list of the captured ServerMessage: the central question of the spike */
const chats = raw.history?.Chats ?? [];
for (const chat of chats) {
  for (const item of chat?.Messages ?? []) {
    console.log('[history ServerMessage keys]', Object.keys(item?.ServerMessage ?? item ?? {}).join(', '));
    const cm = item?.ServerMessage?.ClientMessage ?? item?.ClientMessage;
    const body = cm?.Plain ?? cm?.Ephemeral;
    console.log('[body keys]', Object.keys(body ?? {}).join(', '));
  }
}
const mi = raw.messageInfo?.Message;
console.log('[message_info Message keys]', Object.keys(mi ?? {}).join(', '));
const miServer = mi?.ServerMessage ?? mi;
console.log('[message_info ServerMessage keys]', Object.keys(miServer ?? {}).join(', '));
const miBody = miServer?.ClientMessage?.Plain ?? miServer?.ClientMessage?.Ephemeral;
console.log('[message_info body keys]', Object.keys(miBody ?? {}).join(', '));

ws.close();
process.exit(0);
