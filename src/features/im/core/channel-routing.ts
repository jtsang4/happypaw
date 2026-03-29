import { CHANNEL_PREFIXES } from '../../../shared/im/channel-prefixes.js';

export const CHANNEL_REGISTRY: Record<string, { prefix: string }> =
  Object.fromEntries(
    Object.entries(CHANNEL_PREFIXES).map(([type, prefix]) => [
      type,
      { prefix },
    ]),
  );

export function getChannelType(jid: string): string | null {
  for (const [type, prefix] of Object.entries(CHANNEL_PREFIXES)) {
    if (jid.startsWith(prefix)) return type;
  }
  return null;
}

export function extractChatId(jid: string): string {
  for (const prefix of Object.values(CHANNEL_PREFIXES)) {
    if (jid.startsWith(prefix)) return jid.slice(prefix.length);
  }
  return jid;
}
