import { QueueMetricSchema, type QueueMetric } from "@dot-gov-news/contracts";

import type { OperatorEnv } from "./env";

async function readQueueMetric(
  name: string,
  queue: Queue<unknown> | undefined,
): Promise<QueueMetric> {
  const observedAt = new Date().toISOString();
  if (queue === undefined) {
    return QueueMetricSchema.parse({
      backlogBytes: null,
      backlogCount: null,
      name,
      observedAt,
      oldestMessageAt: null,
      state: "unavailable",
    });
  }

  try {
    const metric = await queue.metrics();
    return QueueMetricSchema.parse({
      backlogBytes: metric.backlogBytes,
      backlogCount: metric.backlogCount,
      name,
      observedAt,
      oldestMessageAt: metric.oldestMessageTimestamp?.toISOString() ?? null,
      state: "available",
    });
  } catch {
    return QueueMetricSchema.parse({
      backlogBytes: null,
      backlogCount: null,
      name,
      observedAt,
      oldestMessageAt: null,
      state: "unavailable",
    });
  }
}

export async function getQueueMetrics(
  env: Pick<OperatorEnv, "MAIN_DLQ" | "MAIN_QUEUE">,
): Promise<QueueMetric[]> {
  return Promise.all([
    readQueueMetric("pipeline-events", env.MAIN_QUEUE),
    readQueueMetric("pipeline-events-dlq", env.MAIN_DLQ),
  ]);
}
