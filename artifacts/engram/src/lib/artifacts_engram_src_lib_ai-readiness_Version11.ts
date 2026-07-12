export async function assertAiReady() {
  const r = await fetch('/api/ai/health');
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.reason || `AI unavailable (${r.status})`);
  }
}