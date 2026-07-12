router.get('/api/ai/health', async (_req, res) => {
  const configured =
    Boolean(process.env.OPENAI_API_KEY) &&
    Boolean(process.env.OPENAI_MODEL);
  if (!configured) {
    return res.status(503).json({
      ok: false,
      reason: 'AI provider not configured',
      hasKey: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL ?? null
    });
  }
  return res.json({ ok: true });
});