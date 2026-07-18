import type { OperatorEnv } from "./env";
import { handleOperatorRequest } from "./router";

export default {
  async fetch(request: Request, env: OperatorEnv): Promise<Response> {
    return handleOperatorRequest(request, env);
  },
} satisfies ExportedHandler<OperatorEnv>;
