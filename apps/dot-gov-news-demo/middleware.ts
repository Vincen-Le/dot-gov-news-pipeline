const PASSWORD = "govnews";
const COOKIE_NAME = "dot_gov_news_access";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function securityHeaders(contentType: string): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeNextPath(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

async function accessToken(): Promise<string> {
  const bytes = new TextEncoder().encode(`dot-gov-news:${PASSWORD}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return mismatch === 0;
}

function cookieValue(request: Request): string | undefined {
  const cookie = request.headers.get("cookie");
  return cookie
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === COOKIE_NAME)?.[1];
}

function loginPage(nextPath: string, invalidPassword = false): Response {
  const error = invalidPassword
    ? '<p class="error" role="alert">That password wasn\'t recognized. Try again.</p>'
    : '<p class="hint">Enter the shared password to continue.</p>';

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#050505" />
    <title>Access · Dot Gov News</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-width: 320px; min-height: 100vh; margin: 0; display: grid; place-items: center; overflow: hidden; color: #f4f3ee; background: #050505; }
      body::before { content: ""; position: fixed; inset: -30%; z-index: -1; background: radial-gradient(circle at 68% 28%, rgba(75, 105, 166, .24), transparent 28%), radial-gradient(circle at 26% 76%, rgba(78, 120, 87, .16), transparent 25%); filter: blur(24px); }
      main { width: min(440px, calc(100vw - 32px)); padding: 42px; background: rgba(12, 12, 12, .9); border: 1px solid #353535; box-shadow: 0 28px 90px rgba(0, 0, 0, .5); }
      .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 54px; color: #b8b8b1; font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
      .mark { display: flex; align-items: end; gap: 2px; height: 18px; }
      .mark i { display: block; width: 6px; background: #f4f3ee; }
      .mark i:nth-child(1) { height: 7px; } .mark i:nth-child(2) { height: 13px; } .mark i:nth-child(3) { height: 18px; }
      .eyebrow { margin: 0 0 10px; color: #8db4ff; font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(30px, 8vw, 42px); font-weight: 600; letter-spacing: -.045em; line-height: 1.05; }
      .hint, .error { min-height: 42px; margin: 16px 0 24px; color: #9b9b94; font-size: 14px; line-height: 1.5; }
      .error { color: #f17878; }
      label { display: block; margin-bottom: 9px; color: #b8b8b1; font-size: 12px; font-weight: 600; letter-spacing: .04em; }
      input { width: 100%; height: 50px; padding: 0 14px; color: #f4f3ee; background: #080808; border: 1px solid #4a4a47; border-radius: 0; font: inherit; outline: none; }
      input:focus { border-color: #8db4ff; box-shadow: 0 0 0 1px #8db4ff; }
      button { width: 100%; height: 50px; margin-top: 12px; color: #050505; background: #f4f3ee; border: 0; border-radius: 0; cursor: pointer; font: 700 13px inherit; letter-spacing: .02em; }
      button:hover { background: #8db4ff; }
      button:focus-visible { outline: 2px solid #8db4ff; outline-offset: 3px; }
      footer { margin-top: 42px; padding-top: 16px; color: #666660; border-top: 1px solid #292929; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
      @media (max-width: 520px) { main { padding: 30px 24px; } .brand { margin-bottom: 42px; } }
    </style>
  </head>
  <body>
    <main>
      <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span> Dot Gov News</div>
      <p class="eyebrow">Restricted preview</p>
      <h1>Newsroom access</h1>
      ${error}
      <form action="/__auth?next=${escapeHtml(nextPath)}" method="post">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
        <button type="submit">Enter newsroom</button>
      </form>
      <footer>OFFICIAL-SOURCE NEWS INTELLIGENCE</footer>
    </main>
  </body>
</html>`,
    {
      headers: securityHeaders("text/html; charset=utf-8"),
      status: invalidPassword ? 401 : 200,
    },
  );
}

export default async function middleware(
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const nextPath = safeNextPath(url.searchParams.get("next"));

  if (url.pathname === "/__auth" && request.method === "POST") {
    const form = await request.formData();
    const submittedPassword = form.get("password");

    if (
      typeof submittedPassword !== "string" ||
      !constantTimeEqual(submittedPassword, PASSWORD)
    ) {
      return loginPage(nextPath, true);
    }

    return new Response(null, {
      headers: {
        location: nextPath,
        "set-cookie": `${COOKIE_NAME}=${await accessToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      },
      status: 303,
    });
  }

  if (constantTimeEqual(cookieValue(request) ?? "", await accessToken())) {
    return undefined;
  }

  if (url.pathname === "/favicon.svg") {
    return undefined;
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      headers: securityHeaders("application/json; charset=utf-8"),
      status: 401,
    });
  }

  const requestedPath = `${url.pathname}${url.search}`;
  return loginPage(safeNextPath(requestedPath));
}
