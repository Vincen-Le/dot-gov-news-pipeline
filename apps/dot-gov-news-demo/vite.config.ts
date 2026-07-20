import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "DOT_GOV_");
  const target = env.DOT_GOV_API_PROXY_TARGET ?? "http://127.0.0.1:4173";
  const session = env.DOT_GOV_API_SESSION_COOKIE;
  const token = env.DOT_GOV_API_TOKEN;
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api/lab": {
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (request) => {
              request.removeHeader("origin");
              request.removeHeader("sec-fetch-site");
              if (token !== undefined && token !== "") {
                request.setHeader("authorization", `Bearer ${token}`);
              } else if (session !== undefined && session !== "") {
                request.setHeader(
                  "cookie",
                  `dot_gov_news_ops_session=${session}`,
                );
              }
            });
          },
          target,
        },
      },
    },
  };
});
