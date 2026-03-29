import { create } from 'zustand';
import { api } from '../api/client.ts';

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
  storagePath: string;
}

interface AgentDefinitionDetailResponse {
  agent: AgentDefinitionDetail;
  storagePath: string;
}

interface AgentDefinitionsState {
  agents: AgentDefinition[];
  loading: boolean;
  error: string | null;
  storagePath: string;

  loadAgents: () => Promise<void>;
  getAgentDetail: (id: string) => Promise<AgentDefinitionDetail>;
  updateAgent: (id: string, content: string) => Promise<void>;
  createAgent: (name: string, content: string) => Promise<string>;
  deleteAgent: (id: string) => Promise<void>;
}

export const useAgentDefinitionsStore = create<AgentDefinitionsState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
  storagePath: '~/.codex/agents',

  loadAgents: async () => {
    set({ loading: true });
    try {
      const data = await api.get<AgentDefinitionsResponse>('/api/agent-definitions');
      set({
        agents: data.agents,
        loading: false,
        error: null,
        storagePath: data.storagePath,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  getAgentDetail: async (id: string) => {
    const data = await api.get<AgentDefinitionDetailResponse>(
      `/api/agent-definitions/${id}`,
    );
    set({ storagePath: data.storagePath });
    return data.agent;
  },

  updateAgent: async (id: string, content: string) => {
    try {
      await api.put(`/api/agent-definitions/${id}`, {
        content,
      });
      set({ error: null });
      await get().loadAgents();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  createAgent: async (name: string, content: string) => {
    try {
      const data = await api.post<{ success: boolean; id: string }>(
        '/api/agent-definitions',
        { name, content },
      );
      set({ error: null });
      await get().loadAgents();
      return data.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  deleteAgent: async (id: string) => {
    try {
      await api.delete(`/api/agent-definitions/${id}`);
      set({ error: null });
      await get().loadAgents();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
}));
