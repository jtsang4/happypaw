import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

import {
  CURRENT_PRODUCT_ID,
  LEGACY_PRODUCT_ID,
} from './legacy-product.js';

type SdkMcpServerConfig = ReturnType<typeof createSdkMcpServer>;

export function buildSdkMcpServerEntries(
  tools: Parameters<typeof createSdkMcpServer>[0]['tools'],
): Record<string, SdkMcpServerConfig> {
  return {
    [CURRENT_PRODUCT_ID]: createSdkMcpServer({
      name: CURRENT_PRODUCT_ID,
      version: '1.0.0',
      tools,
    }),
    [LEGACY_PRODUCT_ID]: createSdkMcpServer({
      name: LEGACY_PRODUCT_ID,
      version: '1.0.0',
      tools,
    }),
  };
}
