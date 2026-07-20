// @vitest-environment node

import { describe, expect, it } from "vitest";

import middleware from "../middleware";

function loginRequest(password: string, next = "/storylines/example"): Request {
  const body = new URLSearchParams({ password });
  return new Request(`https://news.example/__auth?next=${next}`, {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

describe("deployment password middleware", () => {
  it("shows the custom login page for unauthenticated page requests", async () => {
    const response = await middleware(new Request("https://news.example/"));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("Newsroom access");
  });

  it("rejects unauthenticated API requests without returning HTML", async () => {
    const response = await middleware(
      new Request("https://news.example/api/lab/storylines"),
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("content-type")).toContain("application/json");
  });

  it("rejects an incorrect password", async () => {
    const response = await middleware(loginRequest("incorrect"));

    expect(response?.status).toBe(401);
    expect(await response?.text()).toContain("wasn't recognized");
  });

  it("sets an HttpOnly cookie and returns to the requested page", async () => {
    const response = await middleware(loginRequest("govnews"));

    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/storylines/example");
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("allows requests carrying the valid access cookie", async () => {
    const loginResponse = await middleware(loginRequest("govnews"));
    const cookie = loginResponse?.headers.get("set-cookie")?.split(";", 1)[0];
    const response = await middleware(
      new Request("https://news.example/api/lab/storylines", {
        headers: { cookie: cookie ?? "" },
      }),
    );

    expect(response).toBeUndefined();
  });

  it("does not allow external redirect targets", async () => {
    const response = await middleware(loginRequest("govnews", "//evil.test"));

    expect(response?.headers.get("location")).toBe("/");
  });
});
