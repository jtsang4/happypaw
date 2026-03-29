import { api } from '../../../api/client.ts';
import type { AvailableImGroup } from '../../../types.ts';
import type { ChatState, ChatStoreGet, ChatStoreSet } from '../types.ts';

type ImActions = Pick<
  ChatState,
  | 'loadAvailableImGroups'
  | 'bindImGroup'
  | 'unbindImGroup'
  | 'bindMainImGroup'
  | 'unbindMainImGroup'
>;

export function createImActions(_set: ChatStoreSet, get: ChatStoreGet): ImActions {
  return {
    loadAvailableImGroups: async (jid) => {
      try {
        const data = await api.get<{ imGroups: AvailableImGroup[] }>(
          `/api/groups/${encodeURIComponent(jid)}/im-groups`,
        );
        return data.imGroups;
      } catch {
        return [];
      }
    },

    bindImGroup: async (jid, agentId, imJid, force) => {
      try {
        await api.put(
          `/api/groups/${encodeURIComponent(jid)}/agents/${agentId}/im-binding`,
          { im_jid: imJid, ...(force ? { force: true } : {}) },
        );
        void get().loadAgents(jid);
        return true;
      } catch {
        return false;
      }
    },

    unbindImGroup: async (jid, agentId, imJid) => {
      try {
        await api.delete(
          `/api/groups/${encodeURIComponent(jid)}/agents/${agentId}/im-binding/${encodeURIComponent(imJid)}`,
        );
        void get().loadAgents(jid);
        return true;
      } catch {
        return false;
      }
    },

    bindMainImGroup: async (jid, imJid, force, activationMode) => {
      try {
        await api.put(
          `/api/groups/${encodeURIComponent(jid)}/im-binding`,
          {
            im_jid: imJid,
            ...(force ? { force: true } : {}),
            ...(activationMode ? { activation_mode: activationMode } : {}),
          },
        );
        return true;
      } catch {
        return false;
      }
    },

    unbindMainImGroup: async (jid, imJid) => {
      try {
        await api.delete(
          `/api/groups/${encodeURIComponent(jid)}/im-binding/${encodeURIComponent(imJid)}`,
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
