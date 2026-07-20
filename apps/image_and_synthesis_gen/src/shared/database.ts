export interface RestQuery {
  filters?: Readonly<Record<string, string>>;
  order?: string;
}

export class SupabaseRestClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
  ) {}

  public async select(
    table: string,
    columns: string,
    query: RestQuery = {},
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const url = new URL(
        `/rest/v1/${encodeURIComponent(table)}`,
        this.baseUrl,
      );
      url.searchParams.set("select", columns);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      if (query.order !== undefined) url.searchParams.set("order", query.order);
      for (const [field, value] of Object.entries(query.filters ?? {})) {
        url.searchParams.set(field, value);
      }
      const response = await fetch(url, {
        headers: {
          apikey: this.secretKey,
          Authorization: `Bearer ${this.secretKey}`,
        },
      });
      if (!response.ok) {
        throw new Error(
          `Supabase select failed for ${table} (${response.status})`,
        );
      }
      const page: unknown = await response.json();
      if (!Array.isArray(page)) {
        throw new Error(`Supabase returned invalid rows for ${table}`);
      }
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  public async insertImmutable(
    table: string,
    records: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    if (records.length === 0) return;
    const url = new URL(`/rest/v1/${encodeURIComponent(table)}`, this.baseUrl);
    const response = await fetch(url, {
      body: JSON.stringify(records),
      headers: {
        apikey: this.secretKey,
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Supabase immutable insert failed for ${table} (${response.status})`,
      );
    }
  }

  public async rpc(
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const url = new URL(
      `/rest/v1/rpc/${encodeURIComponent(functionName)}`,
      this.baseUrl,
    );
    const response = await fetch(url, {
      body: JSON.stringify(parameters),
      headers: {
        apikey: this.secretKey,
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Supabase RPC failed for ${functionName} (${response.status})`,
      );
    }
  }
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function hostedDatabase(): SupabaseRestClient {
  return new SupabaseRestClient(
    requiredEnvironment("SUPABASE_URL").replace(/\/$/u, ""),
    requiredEnvironment("SUPABASE_SECRET_KEY"),
  );
}
