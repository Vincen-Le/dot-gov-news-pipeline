import type { WorkerEnv } from "./env";
import { handleHealth } from "./handlers/health";
import { handleQueue } from "./handlers/queue";
import { handleScheduled } from "./handlers/scheduled";

export default {
  fetch(request: Request, env: WorkerEnv): Response {
    return handleHealth(request, env);
  },

  async queue(batch: MessageBatch<unknown>, env: WorkerEnv): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
  ): Promise<void> {
    await handleScheduled(controller, env);
  },
} satisfies ExportedHandler<WorkerEnv>;
