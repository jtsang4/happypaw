export const CURRENT_PRODUCT_ID = 'happypaw';
export const CURRENT_PRODUCT_NAME = 'HappyPaw';
export const INTERNAL_MCP_BRIDGE_ID = CURRENT_PRODUCT_ID;

export function isReservedMcpServerId(value: string): boolean {
  return value === CURRENT_PRODUCT_ID || value === INTERNAL_MCP_BRIDGE_ID;
}
