export function editorWaitTimeout() {
  const value = Number(process.env.PENCIL_EDITOR_WAIT_MS ?? 20000);
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647 - 22000) throw new Error('PENCIL_EDITOR_WAIT_MS must be a non-negative integer within the supported timer range');
  return value;
}
