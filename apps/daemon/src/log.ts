/** One JSON line per event: enough to debug routing and auth, never a prompt, a key or a query value. */
export function logLine(record: Record<string, unknown>) {
  if (process.env.PATTY_LOG_LEVEL === 'silent' || (process.env.PATTY_LOG_LEVEL === undefined && process.env.VITEST)) return;
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}
/** A provider error is the only account of why a run failed, and it is worth a line even truncated. */
export const failureDetail = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
};
