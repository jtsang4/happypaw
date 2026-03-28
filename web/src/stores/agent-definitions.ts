import { create } from 'zustand';
import { api } from '../api/client';

export type AgentDefinitionStorageMode = 'project' | 'global';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  updatedAt: string;
}

export interface AgentDefinitionDetail extends AgentDefinition {
  content: string;
}

interface AgentDefinitionsResponse {
  agents: AgentDefinition[];
  storageMode: AgentDefinitionStorageMode;
  storagePath: string;
}

interface AgentDefinitionDetailResponse {
  agent: AgentDefinitionDetail;
  storageMode: AgentDefinitionStorageMode;
  storagePath: string;
}

interface AgentDefinitionsState {
  agents: AgentDefinition[];
  loading: boolean;
  error: string | null;
  storagePath: string;
  storageMode: AgentDefinitionStorageMode;

  loadAgents: (storageMode?: AgentDefinitionStorageMode) => Promise<void>;
  getAgentDetail: (
    id: string,
    storageMode?: AgentDefinitionStorageMode,
  ) => Promise<AgentDefinitionDetail>;
  updateAgent: (
    id: string,
    content: string,
    storageMode?: AgentDefinitionStorageMode,
  ) => Promise<void>;
  createAgent: (
    name: string,
    content: string,
    storageMode?: AgentDefinitionStorageMode,
  ) => Promise<string>;
  deleteAgent: (id: string, storageMode?: AgentDefinitionStorageMode) => Promise<void>;
}

export const useAgentDefinitionsStore = create<AgentDefinitionsState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
  storagePath: '.codex/agents',
  storageMode: 'project',

  loadAgents: async (storageMode = 'project') => {
    set({ loading: true });
    try {
      const data = await api.get<AgentDefinitionsResponse>(
        `/api/agent-definitions?storageMode=${storageMode}`,
      );
      set({
        agents: data.agents,
        loading: false,
        error: null,
        storagePath: data.storagePath,
        storageMode: data.storageMode,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  getAgentDetail: async (id: string, storageMode = get().storageMode) => {
    const data = await api.get<AgentDefinitionDetailResponse>(
      `/api/agent-definitions/${id}?storageMode=${storageMode}`,
    );
    set({ storagePath: data.storagePath, storageMode: data.storageMode });
    return data.agent;
  },

  updateAgent: async (id: string, content: string, storageMode = get().storageMode) => {
    try {
      await api.put(`/api/agent-definitions/${id}?storageMode=${storageMode}`, {
        content,
        storageMode,
      });
      set({ error: null });
      await get().loadAgents(storageMode);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  createAgent: async (name: string, content: string, storageMode = get().storageMode) => {
    try {
      const data = await api.post<{ success: boolean; id: string }>(
        `/api/agent-definitions?storageMode=${storageMode}`,
        { name, content, storageMode },
      );
      set({ error: null });
      await get().loadAgents(storageMode);
      return data.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  deleteAgent: async (id: string, storageMode = get().storageMode) => {
    try {
      await api.delete(`/api/agent-definitions/${id}?storageMode=${storageMode}`);
      set({ error: null });
      await get().loadAgents(storageMode);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
}));
