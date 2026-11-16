import { fetchWithRetry } from "@udmp/core";

/**
 * Thin client over Twenty's REST API (`/rest/<objects>`) and metadata API (`/rest/metadata/*`).
 * Twenty is self-hostable, so `base_url` is configurable; the cloud default is https://api.twenty.com.
 */
export interface TwentyConfig {
  api_key: string;
  base_url?: string;
  /** Page size for listing existing records. Default 60 (Twenty's maximum). */
  page_size?: string | number;
}

export interface TwentyFieldMeta { id: string; name: string; label: string; type: string; isCustom?: boolean; isNullable?: boolean; options?: Array<{ value: string; label: string; position?: number; color?: string }> }
export interface TwentyObjectMeta { id: string; nameSingular: string; namePlural: string; labelSingular?: string; labelPlural?: string; isCustom?: boolean; isActive?: boolean; fields: TwentyFieldMeta[] }

export class TwentyClient {
  readonly base: string;
  private readonly headers: Record<string, string>;
  readonly pageSize: number;
  constructor(cfg: TwentyConfig, readonly signal?: AbortSignal) {
    if (!cfg.api_key) throw new Error("api_key is required (Settings → API & Webhooks in Twenty)");
    this.base = (cfg.base_url ?? "https://api.twenty.com").replace(/\/+$/, "");
    this.headers = { authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json", accept: "application/json" };
    this.pageSize = Math.min(60, Math.max(1, Number(cfg.page_size ?? 60) || 60));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchWithRetry(`${this.base}${path}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body), signal: this.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twenty ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---- metadata -----------------------------------------------------------

  async objects(): Promise<TwentyObjectMeta[]> {
    const r = await this.call<{ data: { objects: TwentyObjectMeta[] } }>("GET", "/rest/metadata/objects");
    return r.data.objects.filter((o) => o.isActive !== false);
  }

  async createField(input: { objectMetadataId: string; name: string; label: string; type: string; options?: TwentyFieldMeta["options"]; isNullable?: boolean; description?: string }): Promise<TwentyFieldMeta> {
    const r = await this.call<{ data: { createOneField: TwentyFieldMeta } }>("POST", "/rest/metadata/fields", { isNullable: true, ...input });
    return r.data.createOneField;
  }

  async createObject(input: { nameSingular: string; namePlural: string; labelSingular: string; labelPlural: string; icon?: string; description?: string }): Promise<TwentyObjectMeta> {
    const r = await this.call<{ data: { createOneObject: TwentyObjectMeta } }>("POST", "/rest/metadata/objects", input);
    return r.data.createOneObject;
  }

  /** A MANY_TO_ONE relation from `objectMetadataId` to `targetObjectMetadataId` (one target → many of this). */
  async createRelationField(input: { objectMetadataId: string; name: string; label: string; targetObjectMetadataId: string; targetFieldLabel: string }): Promise<TwentyFieldMeta> {
    const r = await this.call<{ data: { createOneField: TwentyFieldMeta } }>("POST", "/rest/metadata/fields", {
      objectMetadataId: input.objectMetadataId, name: input.name, label: input.label, type: "RELATION", isNullable: true,
      relationCreationPayload: { targetObjectMetadataId: input.targetObjectMetadataId, targetFieldLabel: input.targetFieldLabel, targetFieldIcon: "IconLink", type: "MANY_TO_ONE" },
    });
    return r.data.createOneField;
  }

  // ---- records ------------------------------------------------------------

  /** List every record of `plural` matching `filter` (Twenty filter syntax, e.g. `name[eq]:"x"`). */
  async *list(plural: string, filter?: string): AsyncGenerator<Record<string, unknown>> {
    let after: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ limit: String(this.pageSize) });
      if (filter) qs.set("filter", filter);
      if (after) qs.set("starting_after", after);
      const r = await this.call<{ data: Record<string, Record<string, unknown>[]>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }>("GET", `/rest/${plural}?${qs}`);
      const rows = r.data[plural] ?? [];
      for (const row of rows) yield row;
      if (!r.pageInfo?.hasNextPage || !r.pageInfo.endCursor || rows.length === 0) return;
      after = r.pageInfo.endCursor;
    }
  }

  async createMany(plural: string, singular: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    const key = `create${capitalize(plural)}`;
    const r = await this.call<{ data: Record<string, Record<string, unknown>[]> }>("POST", `/rest/batch/${plural}`, rows);
    const out = r.data[key] ?? r.data[`create${capitalize(singular)}`];
    if (!Array.isArray(out) || out.length !== rows.length) throw new Error(`Twenty batch create of ${plural} returned ${Array.isArray(out) ? out.length : 0} rows for ${rows.length} inputs`);
    return out;
  }

  async createOne(plural: string, singular: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.call<{ data: Record<string, Record<string, unknown>> }>("POST", `/rest/${plural}`, row);
    return r.data[`create${capitalize(singular)}`];
  }

  async update(plural: string, singular: string, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.call<{ data: Record<string, Record<string, unknown>> }>("PATCH", `/rest/${plural}/${id}`, patch);
    return r.data[`update${capitalize(singular)}`];
  }

  /** Twenty's DELETE is a soft delete (sets deletedAt). */
  async softDelete(plural: string, id: string): Promise<void> {
    await this.call("DELETE", `/rest/${plural}/${id}`);
  }
}

export function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** `cf_annual_contract_value` → `annualContractValue`; Twenty field names must match /^[a-z][a-zA-Z0-9]*$/. */
export function camelField(name: string): string {
  const parts = name.replace(/^cf_/, "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const s = parts.map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())).join("");
  const safe = /^[a-z]/.test(s) ? s : `f${s}`;
  return safe || "field";
}

export function labelOf(name: string): string {
  return name.replace(/^cf_/, "").split(/[_\s]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
