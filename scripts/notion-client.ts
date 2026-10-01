
import {
  loadServiceConfig,
  normalizeLegacyMcpConfig,
  z,
} from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import {
  DEFAULT_RETRY_CONFIG,
  calculateBackoff,
  fetchWithRetry,
  isPreSendNetworkError,
  isRetryableError,
  parseRetryAfterMs,
  withRetry,
} from "./vendor/retry/index.js";

const NotionConfigSchema = z.object({
  notion: z.object({
    apiToken: z.string().min(1),
  }),
});

const RETRYABLE_HTTP_STATUSES = new Set(
  DEFAULT_RETRY_CONFIG.retryableErrors
    .filter((pattern) => /^\d+$/.test(pattern))
    .map((pattern) => Number(pattern))
);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const NON_IDEMPOTENT_RETRYABLE_STATUSES = new Set([429]);
const SINGLE_FETCH_CONFIG = {
  maxRetries: 0,
  retryableErrors: [],
  logger: () => {},
};

export interface NotionApiError extends Error {
  status: number;
  code?: string;
  notionMessage?: string;
  requestId?: string;
  remedy?: string;
}

const NOTION_ERROR_REMEDIES: Record<string, string> = {
  object_not_found:
    'The object exists but is almost certainly not shared with the "Claude Code" integration. '
    + 'Share it: open the page in Notion → ··· menu → Connections → "Claude Code" → Confirm '
    + '(children inherit access). For a workspace-wide grant: notion.so/profile/integrations → '
    + '"Claude Code" → Access → Edit access.',
  unauthorized:
    'The integration token was rejected. Re-materialise credentials with `cred-loader-sync`, then retry.',
  restricted_resource:
    'The integration lacks the capability this endpoint needs (comment read/write is the usual one). '
    + 'Grant it at notion.so/profile/integrations → "Claude Code" → Capabilities.',
  rate_limited:
    'Notion rate-limited the request. The client already retries 429s; if this surfaced, back off and retry later.',
  validation_error:
    'Notion rejected the request shape. Check the property/filter JSON against the database schema '
    + '(`get-database` reports each property name, id, and type).',
};

export const CURRENT_NOTION_API_VERSION = "2026-03-11" as const;
export const LEGACY_NOTION_API_VERSION = "2022-06-28" as const;
export type NotionApiVersion =
  | typeof CURRENT_NOTION_API_VERSION
  | typeof LEGACY_NOTION_API_VERSION;

const ALLOWED_NOTION_API_VERSIONS = new Set<string>([
  CURRENT_NOTION_API_VERSION,
  LEGACY_NOTION_API_VERSION,
]);

export function resolveNotionApiVersion(
  configured: string | undefined = process.env.NOTION_API_VERSION
): NotionApiVersion {
  const version = configured === undefined ? CURRENT_NOTION_API_VERSION : configured;
  if (!ALLOWED_NOTION_API_VERSIONS.has(version)) {
    throw new Error(
      `Unsupported NOTION_API_VERSION "${version}". `
      + `Allowed values are ${CURRENT_NOTION_API_VERSION} (default) and `
      + `${LEGACY_NOTION_API_VERSION} (explicit rollback only).`
    );
  }
  return version as NotionApiVersion;
}

export interface NotionDataSourceTarget {
  dataSourceId?: string;
}

export interface NotionQueryDatabaseOptions extends NotionDataSourceTarget {
  filter?: unknown;
  sorts?: unknown[];
  pageSize?: number;
  startCursor?: string;
}

export interface NotionPageParent {
  database_id?: string;
  data_source_id?: string;
  page_id?: string;
}

interface NotionApiParent extends Record<string, unknown> {
  type?: unknown;
  database_id?: unknown;
  data_source_id?: unknown;
  page_id?: unknown;
}

interface NotionApiObject extends Record<string, unknown> {
  id?: unknown;
  object?: unknown;
  url?: unknown;
  parent?: NotionApiParent;
  database_parent?: NotionApiParent;
  results?: unknown;
  relation?: unknown;
}

interface NotionDatabaseContainer extends NotionApiObject {
  data_sources?: unknown;
}

interface NotionDataSourceSummary {
  id: string;
  name?: string;
}

function normalizeTrashFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTrashFields(item)) as T;
  }
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    normalized[key] = normalizeTrashFields(item);
  }
  if (typeof source.in_trash === "boolean" && typeof source.archived !== "boolean") {
    normalized.archived = source.in_trash;
  }
  return normalized as T;
}

function dataSourceSummaries(container: NotionDatabaseContainer): NotionDataSourceSummary[] {
  if (!Array.isArray(container.data_sources)) return [];
  return container.data_sources.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const id = (candidate as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) return [];
    const name = (candidate as { name?: unknown }).name;
    return [{ id, ...(typeof name === "string" ? { name } : {}) }];
  });
}

function databaseIdFromDataSource(dataSource: NotionApiObject): string | undefined {
  const databaseId = dataSource?.parent?.database_id;
  return typeof databaseId === "string" && databaseId.length > 0
    ? databaseId
    : undefined;
}

function canonicalNotionObjectUrl(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const normalized = id.replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(normalized)
    ? `https://www.notion.so/${normalized}`
    : undefined;
}

export function buildNotionApiError(status: number, errorText: string): NotionApiError {
  const error = new Error(`Notion API error (${status}): ${errorText}`) as NotionApiError;
  error.name = "NotionApiError";
  error.status = status;

  try {
    const parsed = JSON.parse(errorText) as {
      code?: unknown;
      message?: unknown;
      request_id?: unknown;
    };
    if (typeof parsed.code === "string") error.code = parsed.code;
    if (typeof parsed.message === "string") error.notionMessage = parsed.message;
    if (typeof parsed.request_id === "string") error.requestId = parsed.request_id;
  } catch {
  }

  const remedy = error.code ? NOTION_ERROR_REMEDIES[error.code] : undefined;
  if (remedy) {
    error.remedy = remedy;
    error.message = `${error.message}\n\nRemedy: ${remedy}`;
  }
  return error;
}

const MAX_IN_PROCESS_RATE_LIMIT_WAIT_MS = 30_000;

export class NotionRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Notion rate limit: server asked for ${Math.round(retryAfterMs / 1000)}s, ` +
        `which exceeds the ${MAX_IN_PROCESS_RATE_LIMIT_WAIT_MS / 1000}s this client waits in-process. ` +
        `Schedule a resume after the cooldown rather than retrying immediately.`
    );
    this.name = "NotionRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function isOverBudgetRateLimit(error: unknown): boolean {
  return error instanceof NotionRateLimitError;
}

function honourRetryAfterMs(error: unknown): number | undefined {
  const candidate = error as { status?: number; retryAfterMs?: number } | null | undefined;
  if (candidate?.status !== 429) return undefined;
  if (typeof candidate.retryAfterMs !== "number") return undefined;
  return candidate.retryAfterMs;
}

const cache = new PluginCache({
  namespace: "notion-workspace-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class NotionClient {
  private apiToken: string;
  private baseUrl = "https://api.notion.com/v1";
  private notionVersion: NotionApiVersion;
  private dataSourceIdByDatabaseId = new Map<string, Promise<string>>();
  private databaseIdByDataSourceId = new Map<string, Promise<string>>();

  constructor() {
    const raw = loadServiceConfig("notion-workspace-manager");
    const normalized = normalizeLegacyMcpConfig(raw, {
      "notion.apiToken": "NOTION_API_TOKEN",
    });
    const config = NotionConfigSchema.parse(normalized);
    this.apiToken = config.notion.apiToken;
    this.notionVersion = resolveNotionApiVersion();
  }


  disableCache(): void {
    this.dataSourceIdByDatabaseId.clear();
    this.databaseIdByDataSourceId.clear();
    cache.disable();
  }

  enableCache(): void {
    cache.enable();
  }

  getCacheStats() {
    return cache.getStats();
  }

  clearCache(): number {
    this.dataSourceIdByDatabaseId.clear();
    this.databaseIdByDataSourceId.clear();
    return cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }


  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, any>
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const notionVersion = resolveNotionApiVersion(this.notionVersion);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
      "Notion-Version": notionVersion,
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());
    const retryableStatuses = isIdempotent
      ? RETRYABLE_HTTP_STATUSES
      : NON_IDEMPOTENT_RETRYABLE_STATUSES;
    const response = await this.fetchResponseWithRetry(url, options, retryableStatuses, isIdempotent);

    if (!response.ok) {
      const errorText = await response.text();
      throw buildNotionApiError(response.status, errorText);
    }

    return response.json() as Promise<T>;
  }

  private isLegacyVersion(): boolean {
    return resolveNotionApiVersion(this.notionVersion) === LEGACY_NOTION_API_VERSION;
  }

  private rememberDataSourceParent(databaseId: string, dataSourceId: string): void {
    if (cache.isDisabled()) return;
    this.databaseIdByDataSourceId.set(dataSourceId, Promise.resolve(databaseId));
  }

  private rememberSoleDataSource(databaseId: string, dataSourceId: string): void {
    if (cache.isDisabled()) return;
    this.rememberDataSourceParent(databaseId, dataSourceId);
    this.dataSourceIdByDatabaseId.set(databaseId, Promise.resolve(dataSourceId));
  }

  private async resolveDataSourceId(
    databaseId: string | undefined,
    explicitDataSourceId?: string
  ): Promise<string> {
    if (this.isLegacyVersion()) {
      if (explicitDataSourceId) {
        throw new Error(
          `dataSourceId "${explicitDataSourceId}" cannot be used with `
          + `${LEGACY_NOTION_API_VERSION}; provide the legacy database ID instead.`
        );
      }
      if (!databaseId) throw new Error("A database ID is required in Notion rollback mode.");
      return databaseId;
    }

    if (explicitDataSourceId) return explicitDataSourceId;
    if (!databaseId) {
      throw new Error(
        "A database ID or explicit dataSourceId is required for this Notion operation."
      );
    }

    const existing = cache.isDisabled()
      ? undefined
      : this.dataSourceIdByDatabaseId.get(databaseId);
    if (existing) return existing;

    const pending = (async () => {
      const database = await this.request<NotionDatabaseContainer>(
        "GET",
        `/databases/${databaseId}`
      );
      const sources = dataSourceSummaries(database);
      if (sources.length !== 1) {
        const detail = sources.length === 0
          ? "no accessible data sources"
          : `${sources.length} data sources (${sources.map((source) => source.id).join(", ")})`;
        throw new Error(
          `Notion database ${databaseId} has ${detail}. `
          + "Pass an explicit dataSourceId; the client will not choose one automatically."
        );
      }
      this.rememberSoleDataSource(databaseId, sources[0].id);
      return sources[0].id;
    })();
    if (!cache.isDisabled()) this.dataSourceIdByDatabaseId.set(databaseId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.dataSourceIdByDatabaseId.get(databaseId) === pending) {
        this.dataSourceIdByDatabaseId.delete(databaseId);
      }
      throw error;
    }
  }

  private async resolveDatabaseIdForDataSource(dataSourceId: string): Promise<string> {
    const existing = cache.isDisabled()
      ? undefined
      : this.databaseIdByDataSourceId.get(dataSourceId);
    if (existing) return existing;

    const pending = (async () => {
      const dataSource = await this.request<NotionApiObject>(
        "GET",
        `/data_sources/${dataSourceId}`
      );
      const databaseId = databaseIdFromDataSource(dataSource);
      if (!databaseId) {
        throw new Error(
          `Notion data source ${dataSourceId} did not identify its parent database.`
        );
      }
      this.rememberDataSourceParent(databaseId, dataSourceId);
      return databaseId;
    })();
    if (!cache.isDisabled()) this.databaseIdByDataSourceId.set(dataSourceId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.databaseIdByDataSourceId.get(dataSourceId) === pending) {
        this.databaseIdByDataSourceId.delete(dataSourceId);
      }
      throw error;
    }
  }

  private async normalizePageParent(
    page: NotionApiObject,
    knownDatabaseId?: string,
    allowLookup = true
  ): Promise<NotionApiObject> {
    const normalized = normalizeTrashFields(page);
    if (this.isLegacyVersion() || normalized?.parent?.type !== "data_source_id") {
      return normalized;
    }
    const dataSourceId = normalized.parent.data_source_id;
    if (typeof dataSourceId !== "string" || dataSourceId.length === 0) return normalized;
    const embeddedDatabaseId = normalized.parent.database_id;
    let databaseId = knownDatabaseId
      ?? (typeof embeddedDatabaseId === "string" && embeddedDatabaseId.length > 0
        ? embeddedDatabaseId
        : undefined);
    if (!databaseId) {
      const cachedDatabaseId = cache.isDisabled()
        ? undefined
        : this.databaseIdByDataSourceId.get(dataSourceId);
      if (cachedDatabaseId) {
        databaseId = await cachedDatabaseId;
      } else if (allowLookup) {
        databaseId = await this.resolveDatabaseIdForDataSource(dataSourceId);
      } else {
        return normalized;
      }
    }
    this.rememberDataSourceParent(databaseId, dataSourceId);
    return {
      ...normalized,
      parent: { type: "database_id", database_id: databaseId },
      data_source_id: dataSourceId,
    };
  }

  private async resolvePageDatabaseIdBeforeWrite(pageId: string): Promise<string | undefined> {
    if (this.isLegacyVersion()) return undefined;
    const page = await this.request<NotionApiObject>("GET", `/pages/${pageId}`);
    if (page?.parent?.type !== "data_source_id") return undefined;
    const dataSourceId = page.parent.data_source_id;
    if (typeof dataSourceId !== "string" || dataSourceId.length === 0) {
      throw new Error(`Notion page ${pageId} returned an invalid data_source_id parent.`);
    }
    return dataSourceId
      ? this.resolveDatabaseIdForDataSource(dataSourceId)
      : undefined;
  }

  private normalizeDataSourceAsDatabase(
    dataSource: NotionApiObject,
    databaseId?: string
  ): NotionApiObject {
    const normalized = normalizeTrashFields(dataSource);
    const resolvedDatabaseId = databaseIdFromDataSource(normalized)
      ?? databaseId;
    if (!resolvedDatabaseId) {
      throw new Error(
        `Notion data source ${String(normalized?.id ?? "<unknown>")} did not identify its parent database.`
      );
    }
    const dataSourceId = normalized.id;
    if (typeof dataSourceId === "string") {
      this.rememberDataSourceParent(resolvedDatabaseId, dataSourceId);
    }
    return {
      ...normalized,
      object: "database",
      id: resolvedDatabaseId,
      url: normalized.url ?? canonicalNotionObjectUrl(resolvedDatabaseId),
      data_source_id: dataSourceId,
      parent: normalized.database_parent ?? normalized.parent,
    };
  }

  private async normalizeRelationProperties(
    properties: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (this.isLegacyVersion()) return properties;

    const entries = await Promise.all(Object.entries(properties).map(async ([name, property]) => {
      if (!property || typeof property !== "object") {
        return [name, property] as const;
      }
      const propertyRecord = property as NotionApiObject;
      if (!propertyRecord.relation || typeof propertyRecord.relation !== "object") {
        return [name, property] as const;
      }
      const relation = propertyRecord.relation as NotionApiObject;
      const explicitDataSourceId = typeof relation.data_source_id === "string"
        ? relation.data_source_id
        : undefined;
      const databaseId = typeof relation.database_id === "string"
        ? relation.database_id
        : undefined;
      const dataSourceId = await this.resolveDataSourceId(databaseId, explicitDataSourceId);
      const { database_id: _databaseId, ...rest } = relation;
      return [name, { ...propertyRecord, relation: { ...rest, data_source_id: dataSourceId } }] as const;
    }));
    return Object.fromEntries(entries);
  }

  private async fetchResponseWithRetry(
    url: string,
    options: RequestInit,
    retryableStatuses: Set<number>,
    idempotent: boolean
  ): Promise<Response> {
    let lastRetryableResponse: Response | undefined;

    const shouldRetryIdempotent = (error: unknown) =>
      !isOverBudgetRateLimit(error) &&
      isRetryableError(error, DEFAULT_RETRY_CONFIG.retryableErrors);
    const shouldRetryNonIdempotent = (error: unknown) =>
      !isOverBudgetRateLimit(error) &&
      ((error as { status?: number })?.status === 429 || isPreSendNetworkError(error));

    const nextDelayMs = ({
      attempt,
      error,
      baseDelayMs,
      maxDelayMs,
    }: {
      attempt: number;
      error: unknown;
      baseDelayMs: number;
      maxDelayMs: number;
    }) => {
      const retryAfterMs = honourRetryAfterMs(error);

      if (retryAfterMs === undefined || retryAfterMs <= 0) {
        return calculateBackoff(attempt, {
          baseDelayMs,
          maxDelayMs,
          jitterPercent: DEFAULT_RETRY_CONFIG.jitterPercent,
        });
      }

      console.error(
        `[notion] rate limited; honouring Retry-After of ${Math.round(retryAfterMs / 1000)}s ` +
          `before attempt ${attempt + 1}`
      );
      return retryAfterMs;
    };

    const outerConfig = idempotent
      ? { logger: () => {}, shouldRetry: shouldRetryIdempotent, nextDelayMs }
      : { logger: () => {}, shouldRetry: shouldRetryNonIdempotent, nextDelayMs };

    const result = await withRetry(
      async () => {
        const response = await fetchWithRetry(url, options, SINGLE_FETCH_CONFIG);
        if (!response.ok && retryableStatuses.has(response.status)) {
          lastRetryableResponse = response.clone();

          const retryAfterMs =
            response.status === 429
              ? parseRetryAfterMs(response.headers.get("retry-after"))
              : undefined;

          if (retryAfterMs !== undefined && retryAfterMs > MAX_IN_PROCESS_RATE_LIMIT_WAIT_MS) {
            throw new NotionRateLimitError(retryAfterMs);
          }

          const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
          (error as Error & { status?: number }).status = response.status;
          if (retryAfterMs !== undefined) {
            (error as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
          }
          throw error;
        }
        return response;
      },
      outerConfig
    );

    if (result.success) {
      return result.data as Response;
    }

    if (isOverBudgetRateLimit(result.error)) {
      throw result.error;
    }

    if (lastRetryableResponse) {
      return lastRetryableResponse;
    }

    throw result.error || new Error("Notion API request failed after retries");
  }


  async search(
    query: string,
    options?: {
      filter?: { property: string; value: string };
      pageSize?: number;
      startCursor?: string;
      sort?: { timestamp: string; direction: "ascending" | "descending" };
    }
  ): Promise<any> {
    const cacheKey = createCacheKey("search", {
      notionVersion: this.notionVersion,
      query,
      filter: options?.filter ? JSON.stringify(options.filter) : undefined,
      pageSize: options?.pageSize,
      startCursor: options?.startCursor,
      sort: options?.sort ? JSON.stringify(options.sort) : undefined,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const body: Record<string, any> = { query };
        if (options?.filter) {
          const filter = { ...options.filter };
          if (filter.property === "object") {
            if (!this.isLegacyVersion() && filter.value === "database") {
              filter.value = "data_source";
            } else if (this.isLegacyVersion() && filter.value === "data_source") {
              filter.value = "database";
            }
          }
          body.filter = filter;
        }
        if (options?.pageSize) body.page_size = options.pageSize;
        if (options?.startCursor) body.start_cursor = options.startCursor;
        if (options?.sort) body.sort = options.sort;
        const response = await this.request<NotionApiObject>("POST", "/search", body);
        if (this.isLegacyVersion() || !Array.isArray(response.results)) {
          return normalizeTrashFields(response);
        }

        const normalizedDataSources = new Map<NotionApiObject, NotionApiObject>();
        const databaseIdsByDataSourceId = new Map<string, string>();
        for (const item of response.results) {
          if (item && typeof item === "object" && item.object === "data_source") {
            const normalized = this.normalizeDataSourceAsDatabase(item);
            normalizedDataSources.set(item, normalized);
            if (typeof item.id === "string" && typeof normalized.id === "string") {
              databaseIdsByDataSourceId.set(item.id, normalized.id);
            }
          }
        }
        const results = await Promise.all(response.results.map(async (item: unknown) => {
          if (!item || typeof item !== "object") return item;
          const record = item as NotionApiObject;
          if (record.object === "data_source") {
            return normalizedDataSources.get(record);
          }
          if (record.object === "page") {
            const dataSourceId = record.parent?.data_source_id;
            const knownDatabaseId = typeof dataSourceId === "string"
              ? databaseIdsByDataSourceId.get(dataSourceId)
              : undefined;
            return this.normalizePageParent(record, knownDatabaseId, false);
          }
          return normalizeTrashFields(record);
        }));
        return { ...normalizeTrashFields(response), results };
      },
      { ttl: TTL.FIVE_MINUTES }
    );
  }


  async getPage(pageId: string): Promise<any> {
    const cacheKey = createCacheKey("page", { id: pageId, notionVersion: this.notionVersion });
    return cache.getOrFetch(
      cacheKey,
      async () => this.normalizePageParent(
        await this.request<NotionApiObject>("GET", `/pages/${pageId}`)
      ),
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  async getBlocks(
    blockId: string,
    options?: { startCursor?: string; pageSize?: number }
  ): Promise<any> {
    const cacheKey = createCacheKey("blocks", {
      id: blockId,
      notionVersion: this.notionVersion,
      startCursor: options?.startCursor,
      pageSize: options?.pageSize,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params = new URLSearchParams();
        if (options?.startCursor) params.set("start_cursor", options.startCursor);
        if (options?.pageSize) params.set("page_size", String(options.pageSize));
        const query = params.toString() ? `?${params.toString()}` : "";
        return normalizeTrashFields(
          await this.request("GET", `/blocks/${blockId}/children${query}`)
        );
      },
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  async createPage(
    parent: NotionPageParent,
    properties: Record<string, any>,
    children?: any[]
  ): Promise<any> {
    let requestParent: Record<string, string>;
    let publicDatabaseId: string | undefined;
    if (parent.data_source_id) {
      if (this.isLegacyVersion()) {
        throw new Error(
          `data_source_id parents cannot be used with ${LEGACY_NOTION_API_VERSION}.`
        );
      }
      requestParent = { type: "data_source_id", data_source_id: parent.data_source_id };
      publicDatabaseId = await this.resolveDatabaseIdForDataSource(parent.data_source_id);
    } else if (parent.page_id) {
      requestParent = { type: "page_id", page_id: parent.page_id };
    } else if (this.isLegacyVersion()) {
      if (!parent.database_id) throw new Error("A database_id or page_id parent is required.");
      requestParent = { type: "database_id", database_id: parent.database_id };
      publicDatabaseId = parent.database_id;
    } else {
      const dataSourceId = await this.resolveDataSourceId(
        parent.database_id,
        parent.data_source_id
      );
      requestParent = { type: "data_source_id", data_source_id: dataSourceId };
      publicDatabaseId = parent.database_id;
    }

    const body: NotionApiObject = { parent: requestParent, properties };
    if (children) body.children = children;
    const result = await this.normalizePageParent(
      await this.request<NotionApiObject>("POST", "/pages", body),
      publicDatabaseId
    );
    cache.invalidatePattern(/^search/);
    cache.invalidatePattern(/^database_query/);
    return result;
  }

  async updatePage(
    pageId: string,
    properties: Record<string, any>,
    archived?: boolean
  ): Promise<any> {
    const publicDatabaseId = await this.resolvePageDatabaseIdBeforeWrite(pageId);
    const body: Record<string, any> = { properties };
    if (archived !== undefined) {
      body[this.isLegacyVersion() ? "archived" : "in_trash"] = archived;
    }
    const result = await this.normalizePageParent(
      await this.request<NotionApiObject>("PATCH", `/pages/${pageId}`, body),
      publicDatabaseId,
      false
    );
    cache.invalidate(createCacheKey("page", { id: pageId, notionVersion: this.notionVersion }));
    cache.invalidatePattern(/^search/);
    cache.invalidatePattern(/^database_query/);
    return result;
  }

  async archivePage(pageId: string): Promise<any> {
    const publicDatabaseId = await this.resolvePageDatabaseIdBeforeWrite(pageId);
    const result = await this.normalizePageParent(
      await this.request<NotionApiObject>(
        "PATCH",
        `/pages/${pageId}`,
        this.isLegacyVersion() ? { archived: true } : { in_trash: true }
      ),
      publicDatabaseId,
      false
    );
    cache.invalidate(createCacheKey("page", { id: pageId, notionVersion: this.notionVersion }));
    cache.invalidatePattern(/^search/);
    cache.invalidatePattern(/^database_query/);
    return result;
  }


  async getDatabase(
    databaseId: string | undefined,
    options: NotionDataSourceTarget = {}
  ): Promise<any> {
    const cacheKey = createCacheKey("database", {
      id: databaseId,
      dataSourceId: options.dataSourceId,
      notionVersion: this.notionVersion,
    });
    return cache.getOrFetch(
      cacheKey,
      async () => {
        if (this.isLegacyVersion()) {
          const resolvedDatabaseId = await this.resolveDataSourceId(
            databaseId,
            options.dataSourceId
          );
          return normalizeTrashFields(
            await this.request("GET", `/databases/${resolvedDatabaseId}`)
          );
        }
        const dataSourceId = await this.resolveDataSourceId(
          databaseId,
          options.dataSourceId
        );
        const dataSource = await this.request<NotionApiObject>(
          "GET",
          `/data_sources/${dataSourceId}`
        );
        return this.normalizeDataSourceAsDatabase(dataSource, databaseId);
      },
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  async queryDatabase(
    databaseId: string | undefined,
    options: NotionQueryDatabaseOptions = {}
  ): Promise<any> {
    const cacheKey = createCacheKey("database_query", {
      id: databaseId,
      dataSourceId: options.dataSourceId,
      notionVersion: this.notionVersion,
      filter: options?.filter ? JSON.stringify(options.filter) : undefined,
      sorts: options?.sorts ? JSON.stringify(options.sorts) : undefined,
      pageSize: options?.pageSize,
      startCursor: options?.startCursor,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const body: Record<string, any> = {};
        if (options?.filter) body.filter = options.filter;
        if (options?.sorts) body.sorts = options.sorts;
        if (options?.pageSize) body.page_size = options.pageSize;
        if (options?.startCursor) body.start_cursor = options.startCursor;
        if (this.isLegacyVersion()) {
          const resolvedDatabaseId = await this.resolveDataSourceId(
            databaseId,
            options.dataSourceId
          );
          return normalizeTrashFields(
            await this.request("POST", `/databases/${resolvedDatabaseId}/query`, body)
          );
        }
        const dataSourceId = await this.resolveDataSourceId(
          databaseId,
          options.dataSourceId
        );
        const publicDatabaseId = options.dataSourceId
          ? await this.resolveDatabaseIdForDataSource(dataSourceId)
          : databaseId;
        if (!publicDatabaseId) {
          throw new Error(`Notion data source ${dataSourceId} did not identify its parent database.`);
        }
        const response = await this.request<NotionApiObject>(
          "POST",
          `/data_sources/${dataSourceId}/query`,
          body
        );
        const results = Array.isArray(response.results)
          ? await Promise.all(response.results.map((page: unknown) =>
              page && typeof page === "object"
                ? this.normalizePageParent(page as NotionApiObject, publicDatabaseId)
                : page))
          : response.results;
        return { ...normalizeTrashFields(response), ...(results ? { results } : {}) };
      },
      { ttl: TTL.FIVE_MINUTES }
    );
  }

  async createDatabaseRow(
    databaseId: string | undefined,
    properties: Record<string, any>,
    options: NotionDataSourceTarget = {}
  ): Promise<any> {
    return this.createPage(
      this.isLegacyVersion()
        ? { database_id: databaseId }
        : { database_id: databaseId, data_source_id: options.dataSourceId },
      properties
    );
  }

  async createDatabase(
    parentPageId: string,
    title: string,
    properties: Record<string, any>
  ): Promise<any> {
    const requestProperties = await this.normalizeRelationProperties(properties);
    const body: NotionApiObject = {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
    };
    if (this.isLegacyVersion()) {
      body.properties = requestProperties;
    } else {
      body.initial_data_source = { properties: requestProperties };
    }
    const raw = await this.request<NotionApiObject>("POST", "/databases", body);
    const createdSources = dataSourceSummaries(raw);
    const createdDataSourceId = createdSources.length === 1
      ? createdSources[0].id
      : undefined;
    const result = this.isLegacyVersion()
      ? normalizeTrashFields(raw)
      : normalizeTrashFields({
          parent: body.parent,
          title: [{ type: "text", text: { content: title }, plain_text: title }],
          properties,
          in_trash: false,
          ...raw,
          object: "database",
          url: raw.url ?? canonicalNotionObjectUrl(raw.id),
          ...(createdDataSourceId ? { data_source_id: createdDataSourceId } : {}),
        });
    if (!this.isLegacyVersion() && typeof raw.id === "string") {
      if (createdDataSourceId) this.rememberSoleDataSource(raw.id, createdDataSourceId);
    }
    cache.invalidatePattern(/^search/);
    cache.invalidatePattern(/^databases_list/);
    return result;
  }


  async updateDatabaseProperties(
    databaseId: string | undefined,
    properties: Record<string, any>,
    options: NotionDataSourceTarget = {}
  ): Promise<any> {
    const requestProperties = await this.normalizeRelationProperties(properties);
    const targetId = await this.resolveDataSourceId(databaseId, options.dataSourceId);
    const endpoint = this.isLegacyVersion()
      ? `/databases/${targetId}`
      : `/data_sources/${targetId}`;
    const raw = await this.request<NotionApiObject>("PATCH", endpoint, {
      properties: requestProperties,
    });
    cache.invalidatePattern(/^database/);
    cache.invalidatePattern(/^databases_list/);
    cache.invalidatePattern(/^query_database/);
    cache.invalidatePattern(/^search/);
    return normalizeTrashFields(raw);
  }

  async getBlock(blockId: string): Promise<any> {
    const cacheKey = createCacheKey("block", { id: blockId, notionVersion: this.notionVersion });
    return cache.getOrFetch(
      cacheKey,
      async () => normalizeTrashFields(
        await this.request("GET", `/blocks/${blockId}`)
      ),
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  private parentIdFromBlock(block: any): string | null {
    const parent = block?.parent;
    if (!parent) return null;
    const pageParent = parent.page_id;
    if (typeof pageParent === "string" && pageParent.length > 0) return pageParent;
    const blockParent = parent.block_id;
    if (typeof blockParent === "string" && blockParent.length > 0) return blockParent;
    return null;
  }

  private evictParentChildrenCache(parentId: string): void {
    const exactChildrenKey = createCacheKey("blocks", { id: parentId, notionVersion: this.notionVersion });
    cache.invalidate(exactChildrenKey);
    const escapedParentId = parentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const childrenForParentPattern = new RegExp(`^blocks\\?(?:[^&]*&)*id=${escapedParentId}(?:&|$)`);
    cache.invalidatePattern(childrenForParentPattern);
  }

  private evictParentBlockCache(parentId: string): void {
    cache.invalidate(createCacheKey("block", { id: parentId, notionVersion: this.notionVersion }));
  }

  private async resolveParentId(blockId: string, mutationResult: any): Promise<string | null> {
    const parentFromResult = this.parentIdFromBlock(mutationResult);
    if (parentFromResult) return parentFromResult;
    const fetchedBlock = await this.request<any>("GET", `/blocks/${blockId}`);
    return this.parentIdFromBlock(fetchedBlock);
  }

  async appendBlocks(blockId: string, children: any[], options: { after?: string } = {}): Promise<any> {
    const requestBody: NotionApiObject = { children };
    if (options.after) {
      if (this.isLegacyVersion()) {
        requestBody.after = options.after;
      } else {
        requestBody.position = {
          type: "after_block",
          after_block: { id: options.after },
        };
      }
    }
    const result = normalizeTrashFields(
      await this.request("PATCH", `/blocks/${blockId}/children`, requestBody)
    );
    const parentId = blockId;
    this.evictParentChildrenCache(parentId);
    this.evictParentBlockCache(parentId);
    return result;
  }

  async deleteBlock(blockId: string): Promise<any> {
    const result = normalizeTrashFields(
      await this.request<any>("DELETE", `/blocks/${blockId}`)
    );
    cache.invalidate(createCacheKey("block", { id: blockId, notionVersion: this.notionVersion }));
    const parentId = this.parentIdFromBlock(result);
    if (parentId) {
      this.evictParentChildrenCache(parentId);
      this.evictParentBlockCache(parentId);
    }
    return result;
  }

  async updateBlock(blockId: string, payload: Record<string, any>): Promise<any> {
    const result = normalizeTrashFields(
      await this.request<any>("PATCH", `/blocks/${blockId}`, payload)
    );
    cache.invalidate(createCacheKey("block", { id: blockId, notionVersion: this.notionVersion }));
    const parentId = await this.resolveParentId(blockId, result);
    if (parentId) {
      this.evictParentChildrenCache(parentId);
    }
    return result;
  }


  async listUsers(options?: {
    startCursor?: string;
    pageSize?: number;
  }): Promise<any> {
    const cacheKey = createCacheKey("users", {
      ...(options || {}),
      notionVersion: this.notionVersion,
    });
    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params = new URLSearchParams();
        if (options?.startCursor) params.set("start_cursor", options.startCursor);
        if (options?.pageSize) params.set("page_size", String(options.pageSize));
        const query = params.toString() ? `?${params.toString()}` : "";
        return this.request("GET", `/users${query}`);
      },
      { ttl: TTL.HOUR }
    );
  }

  async getUser(userId: string): Promise<any> {
    const cacheKey = createCacheKey("user", { id: userId, notionVersion: this.notionVersion });
    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `/users/${userId}`),
      { ttl: TTL.HOUR }
    );
  }

  async getSelf(): Promise<any> {
    return cache.getOrFetch(
      `self:${this.notionVersion}`,
      () => this.request("GET", "/users/me"),
      { ttl: TTL.HOUR }
    );
  }


  async getComments(options: {
    blockId?: string;
    startCursor?: string;
    pageSize?: number;
  }): Promise<any> {
    const cacheKey = createCacheKey("comments", {
      ...options,
      notionVersion: this.notionVersion,
    });
    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params = new URLSearchParams();
        if (options.blockId) params.set("block_id", options.blockId);
        if (options.startCursor) params.set("start_cursor", options.startCursor);
        if (options.pageSize) params.set("page_size", String(options.pageSize));
        return this.request("GET", `/comments?${params.toString()}`);
      },
      { ttl: TTL.FIVE_MINUTES }
    );
  }

  async createComment(options: {
    parent?: { page_id: string };
    discussion_id?: string;
    rich_text: any[];
  }): Promise<any> {
    const result = await this.request("POST", "/comments", options);
    if (options.parent?.page_id) {
      cache.invalidatePattern(new RegExp(`^comments.*${options.parent.page_id}`));
    }
    return result;
  }


  async listDatabases(): Promise<any> {
    return cache.getOrFetch(
      `databases_list:${this.notionVersion}`,
      async () => {
        const results: unknown[] = [];
        const seenCursors = new Set<string>();
        let startCursor: string | undefined;
        do {
          const response = await this.search("", {
            filter: { property: "object", value: "database" },
            startCursor,
            pageSize: 100,
          });
          if (Array.isArray(response.results)) results.push(...response.results);
          const nextCursor = typeof response.next_cursor === "string"
            ? response.next_cursor
            : undefined;
          if (response.has_more === true && !nextCursor) {
            throw new Error("Notion database search reported has_more without a next_cursor.");
          }
          if (nextCursor && seenCursors.has(nextCursor)) {
            throw new Error(`Notion database search repeated cursor ${nextCursor}.`);
          }
          if (nextCursor) seenCursors.add(nextCursor);
          startCursor = nextCursor;
        } while (startCursor);
        return { object: "list", results, has_more: false, next_cursor: null };
      },
      { ttl: TTL.FIVE_MINUTES }
    );
  }
}

export default NotionClient;
