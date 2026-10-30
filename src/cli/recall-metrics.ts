import {
  checkRecallAlerts,
  defaultRecallMetricsDates,
  resolveRecallMetricsPaths,
  rollupRecallMetrics,
} from "../metrics/recall";

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const exact = args.find((arg) => arg.startsWith(prefix));
  return exact?.slice(prefix.length);
}

function usage(): void {
  console.log(
    "Usage: duckbrain recall-metrics [rollup|check] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--counter=PATH] [--health=PATH] [--alerts=PATH]",
  );
}

export async function recallMetricsCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const action = args[0] === "check" ? "check" : "rollup";
  const defaults = defaultRecallMetricsDates(7);
  const from = flag(args, "from") ?? defaults.from;
  const to = flag(args, "to") ?? defaults.to;
  const counterFile = flag(args, "counter");
  const healthFile = flag(args, "health");
  const alertsFile = flag(args, "alerts");
  const healthCheck = flag(args, "health-check") ?? "GET /health status=200";
  const paths = resolveRecallMetricsPaths(counterFile);
  const options = { counterFile, healthFile, from, to, healthCheck };
  const rows = rollupRecallMetrics(options);
  for (const row of rows) {
    console.log(
      `${row.day} prefetch=${row.prefetchCalls} calls_answered=${row.callsAnswered}/${row.prefetchCalls} non_empty_packs=${row.nonEmptyPacks}/${row.prefetchCalls} distinct_namespaces=${row.distinctNamespaces} records=${row.recordsReturned}/${row.prefetchCalls} healthy=${row.healthy ?? "unknown"} health_source=${row.healthSource}`,
    );
  }
  console.log(
    `counter_file=${paths.counterFile} health_file=${paths.healthFile} health_check=${healthCheck}`,
  );
  if (action === "check") {
    const alerts = checkRecallAlerts({ ...options, alertsFile });
    for (const alert of alerts) {
      console.error(
        `ALERT zero_non_empty_packs day=${alert.day} counter_file=${alert.counterFile} health_file=${alert.healthFile} health_check=${alert.healthCheck}`,
      );
    }
    if (alerts.length > 0) process.exitCode = 1;
  }
}
