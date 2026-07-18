import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL, loadOperatorConfig } from "../src/config";

describe("loadOperatorConfig databaseUrl", () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("defaults to the local bench database when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    expect(loadOperatorConfig().databaseUrl).toBe(LOCAL_DATABASE_URL);
  });

  it("prefers an explicit DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db.example.com:5432/postgres";
    expect(loadOperatorConfig().databaseUrl).toBe(
      "postgresql://u:p@db.example.com:5432/postgres",
    );
  });
});
