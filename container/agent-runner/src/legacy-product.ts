const CURRENT_SUFFIX_LOWER = 'paw';
const LEGACY_SUFFIX_LOWER = 'claw';

export const CURRENT_PRODUCT_ID = 'happypaw';
export const LEGACY_PRODUCT_ID = toLegacyProductToken(CURRENT_PRODUCT_ID);
export const INTERNAL_MCP_BRIDGE_ID = CURRENT_PRODUCT_ID;

export function toLegacyProductToken(value: string): string {
  return value.replaceAll(CURRENT_SUFFIX_LOWER, LEGACY_SUFFIX_LOWER);
}
