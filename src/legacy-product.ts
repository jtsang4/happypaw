const CURRENT_SUFFIX_LOWER = 'paw';
const LEGACY_SUFFIX_LOWER = 'claw';
const CURRENT_SUFFIX_UPPER = 'Paw';
const LEGACY_SUFFIX_UPPER = 'Claw';
const CURRENT_SUFFIX_ENV = CURRENT_SUFFIX_LOWER.toUpperCase();
const LEGACY_SUFFIX_ENV = LEGACY_SUFFIX_LOWER.toUpperCase();

export const CURRENT_PRODUCT_ID = 'happypaw';
export const CURRENT_PRODUCT_NAME = 'HappyPaw';
export const LEGACY_PRODUCT_ID = toLegacyProductToken(CURRENT_PRODUCT_ID);
export const LEGACY_PRODUCT_NAME = toLegacyProductToken(CURRENT_PRODUCT_NAME);
export const LEGACY_AGENT_SENDER = `${LEGACY_PRODUCT_ID}-agent`;

export function toLegacyProductToken(value: string): string {
  return value
    .replaceAll(CURRENT_SUFFIX_UPPER, LEGACY_SUFFIX_UPPER)
    .replaceAll(CURRENT_SUFFIX_LOWER, LEGACY_SUFFIX_LOWER);
}

export function toLegacyProductEnvToken(value: string): string {
  return value.replaceAll(CURRENT_SUFFIX_ENV, LEGACY_SUFFIX_ENV);
}
