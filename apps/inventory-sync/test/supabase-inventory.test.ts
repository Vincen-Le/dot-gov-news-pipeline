import { describe, expect, it } from "vitest";

import { parseInventoryRunId } from "../src/supabase-inventory";

describe("Supabase inventory RPC contracts", () => {
  it("accepts the scalar UUID returned by begin_gsa_inventory_sync", () => {
    expect(parseInventoryRunId("1a721690-51b1-488c-9018-b0f536366629")).toBe(
      "1a721690-51b1-488c-9018-b0f536366629",
    );
  });

  it("rejects object-shaped and malformed run identifiers", () => {
    expect(() =>
      parseInventoryRunId({ id: "1a721690-51b1-488c-9018-b0f536366629" }),
    ).toThrow("invalid UUID");
    expect(() => parseInventoryRunId("undefined")).toThrow("invalid UUID");
  });
});
