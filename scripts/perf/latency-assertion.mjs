export function evaluateLatency(samplesByNamespace, env = process.env) {
  const rawCeiling = env.PERF_ASSERT_MS;
  const ceilingMs = rawCeiling === undefined ? 500 : Number(rawCeiling);
  if (!Number.isFinite(ceilingMs) || ceilingMs < 0) {
    throw new Error(`PERF_ASSERT_MS must be a non-negative number; received ${rawCeiling}`);
  }

  for (const [namespace, samples] of Object.entries(samplesByNamespace)) {
    for (const sampleMs of samples) {
      if (sampleMs > ceilingMs) {
        return { pass: false, ceilingMs, namespace, sampleMs };
      }
    }
  }

  return { pass: true, ceilingMs };
}
