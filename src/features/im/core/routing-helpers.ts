import { getJidsByFolder, getRegisteredGroup } from '../../../db.js';
import { logger } from '../../../app/logger.js';
import type { IMChannel, UserIMConnection } from './channel-types.js';

export function findChannelForJid(
  connections: Map<string, UserIMConnection>,
  jid: string,
  channelType: string,
): IMChannel | undefined {
  const group = getRegisteredGroup(jid);
  if (group?.created_by) {
    const channel = connections
      .get(group.created_by)
      ?.channels.get(channelType);
    if (channel?.isConnected()) return channel;
  }

  if (!group) return undefined;

  for (const siblingJid of getJidsByFolder(group.folder)) {
    if (siblingJid === jid) continue;
    const sibling = getRegisteredGroup(siblingJid);
    if (!sibling?.created_by) continue;

    const channel = connections
      .get(sibling.created_by)
      ?.channels.get(channelType);
    if (!channel?.isConnected()) continue;

    logger.warn(
      { jid, fallbackUserId: sibling.created_by, folder: group.folder },
      'IM message routed via sibling group owner connection',
    );
    return channel;
  }

  return undefined;
}
