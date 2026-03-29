export function stripAgentInternalTags(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<process>[\s\S]*?<\/process>/g, '')
    .trim();
}

export function isSystemMaintenanceNoise(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 30) return false;
  const NOISE_PATTERNS = [
    /^ok[.。!！]?$/,
    /^好的[.。!！]?$/,
    /^已更新/,
    /^已完成/,
    /^已刷新/,
    /^记忆已/,
    /^agents\.md\s*已/,
    /^memory\s*(flush|updated)/i,
  ];
  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}
