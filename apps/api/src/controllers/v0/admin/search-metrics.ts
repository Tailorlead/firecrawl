import { Request, Response } from "express";
import { readMetrics } from "../../../search/v2/searchMetrics";
import { logger } from "../../../lib/logger";

/**
 * Returns aggregated search metrics for the requested time window.
 * Query params:
 *   - hours (default 24, max 168)
 *   - format=prometheus -> text/plain in Prometheus exposition format
 */
export async function searchMetricsController(req: Request, res: Response) {
  try {
    const hoursParam = parseInt(String(req.query.hours ?? "24"), 10);
    const hours =
      Number.isFinite(hoursParam) && hoursParam > 0
        ? Math.min(hoursParam, 168)
        : 24;

    const rows = await readMetrics(hours);

    // Aggregate by metric (sum across hours) for the headline view.
    const totals: Record<string, number> = {};
    for (const r of rows) {
      totals[r.metric] = (totals[r.metric] ?? 0) + r.count;
    }

    if (req.query.format === "prometheus") {
      const lines: string[] = [
        "# HELP firecrawl_search_total Search counters grouped by engine/cache outcome",
        "# TYPE firecrawl_search_total counter",
      ];
      for (const [metric, count] of Object.entries(totals)) {
        const [kind, ...rest] = metric.split(".");
        const label = rest.join(".");
        lines.push(
          `firecrawl_search_total{kind="${kind}",label="${label}"} ${count}`,
        );
      }
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      return res.status(200).send(lines.join("\n") + "\n");
    }

    return res.status(200).json({
      windowHours: hours,
      totals,
      hourly: rows,
    });
  } catch (error: any) {
    logger.error("search-metrics controller failed", {
      error: error?.message,
    });
    return res.status(500).json({ error: "metrics_unavailable" });
  }
}
