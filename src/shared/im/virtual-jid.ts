export function stripVirtualJidSuffix(jid: string): string {
  const taskSep = jid.indexOf('#task:');
  if (taskSep >= 0) return jid.slice(0, taskSep);
  const agentSep = jid.indexOf('#agent:');
  if (agentSep >= 0) return jid.slice(0, agentSep);
  return jid;
}
