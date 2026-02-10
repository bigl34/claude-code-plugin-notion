/**
 * Notion API Client
 *
 * Direct client for the Notion REST API v1.
 * Provides access to the YOUR_COMPANY Notion workspace.
 *
 * Key features:
 * - Search: workspace-wide search with filters
 * - Pages: create, read, update, archive
 * - Databases: query with filters and sorts
 * - Blocks: content manipulation
 * - Users: workspace members
 * - Comments: page and block comments
 *
 * Uses API version 2022-06-28 for all operations.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Support both new format and legacy MCP format
interface NotionConfigNew {
  notion: { apiToken: string };
}

interface NotionConfigLegacy {
  mcpServer: { env: { NOTION_API_TOKEN: string } };
}

type NotionConfig = NotionConfigNew | NotionConfigLegacy;

// Initialize cache with namespace
const cache = new PluginCache({
  namespace: "notion-workspace-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class NotionClient {
  private apiToken: string;
  private baseUrl = "https://api.notion.com/v1";
  private notionVersion = "2022-06-28";
  private cacheDisabled: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    const configFile: NotionConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // Support both new format and legacy MCP format
    if ("notion" in configFile && configFile.notion?.apiToken) {
      this.apiToken = configFile.notion.apiToken;
    } else if ("mcpServer" in configFile && configFile.mcpServer?.env?.NOTION_API_TOKEN) {
      this.apiToken = configFile.mcpServer.env.NOTION_API_TOKEN;
    } else {
      throw new Error("Missing Notion API token in config.json (expected notion.apiToken or mcpServer.env.NOTION_API_TOKEN)");
    }
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /** Disables caching for all subsequent requests. */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /** Re-enables caching after it was disabled. */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /** Returns cache statistics including hit/miss counts. */
  getCacheStats() {
    return cache.getStats();
  }

  /** Clears all cached data. @returns Number of cache entries cleared */
  clearCache(): number {
    return cache.clear();
  }

  /** Invalidates a specific cache entry by key. */
  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  // ============================================
  // INTERNAL
  // ============================================

  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, any>
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
      "Notion-Version": this.notionVersion,
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Notion API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  // ============================================
  // SEARCH OPERATIONS
  // ============================================

  /**
   * Searches the Notion workspace.
   *
   * @param query - Search query text
   * @param options - Search options
   * @param options.filter - Filter by object type (page or database)
   * @param options.pageSize - Max results to return (max 100)
   * @param options.startCursor - Pagination cursor
   * @returns Search results with pages/databases matching query
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * // Search for pages containing "SOP"
   * await client.search("SOP");
   *
   * // Search only databases
   * await client.search("", { filter: { property: "object", value: "database" } });
   */
  async search(
    query: string,
    options?: {
      filter?: { property: string; value: string };
      pageSize?: number;
      startCursor?: string;
    }
  ): Promise<any> {
    const cacheKey = createCacheKey("search", {
      query,
      filter: options?.filter ? JSON.stringify(options.filter) : undefined,
      pageSize: options?.pageSize,
      startCursor: options?.startCursor,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const body: Record<string, any> = { query };
        if (options?.filter) body.filter = options.filter;
        if (options?.pageSize) body.page_size = options.pageSize;
        if (options?.startCursor) body.start_cursor = options.startCursor;
        return this.request("POST", "/search", body);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // PAGE OPERATIONS
  // ============================================

  /** Gets a page by ID. @cached TTL: 15 minutes */
  async getPage(pageId: string): Promise<any> {
    const cacheKey = createCacheKey("page", { id: pageId });
    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `/pages/${pageId}`),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets child blocks of a page or block.
   *
   * @param blockId - Page or block ID
   * @param options - Pagination options
   * @returns Block children with content
   *
   * @cached TTL: 15 minutes
   */
  async getBlocks(
    blockId: string,
    options?: { startCursor?: string; pageSize?: number }
  ): Promise<any> {
    const cacheKey = createCacheKey("blocks", {
      id: blockId,
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
        return this.request("GET", `/blocks/${blockId}/children${query}`);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Creates a new page.
   *
   * @param parent - Parent location (database_id or page_id)
   * @param properties - Page properties
   * @param children - Optional initial content blocks
   * @returns Created page details
   *
   * @invalidates search/*, database_query/{database_id}
   */
  async createPage(
    parent: { database_id?: string; page_id?: string },
    properties: Record<string, any>,
    children?: any[]
  ): Promise<any> {
    const body: Record<string, any> = { parent, properties };
    if (children) body.children = children;
    const result = await this.request("POST", "/pages", body);
    cache.invalidatePattern(/^search/);
    if (parent.database_id) {
      cache.invalidatePattern(new RegExp(`^database_query.*${parent.database_id}`));
    }
    return result;
  }

  /**
   * Updates a page's properties.
   *
   * @param pageId - Page ID to update
   * @param properties - Properties to update
   * @param archived - Whether to archive the page
   * @returns Updated page details
   *
   * @invalidates page/{pageId}, search/*, database_query/*
   */
  async updatePage(
    pageId: string,
    properties: Record<string, any>,
    archived?: boolean
  ): Promise<any> {
    const body: Record<string, any> = { properties };
    if (archived !== undefined) body.archived = archived;
    const result = await this.request("PATCH", `/pages/${pageId}`, body);
    cache.invalidate(createCacheKey("page", { id: pageId }));
    cache.invalidatePattern(/^search/);
    cache.invalidatePattern(/^database_query/);
    return result;
  }

  /**
   * Archives (soft deletes) a page.
   *
   * @param pageId - Page ID to archive
   * @returns Archived page details
   *
   * @invalidates page/{pageId}, search/*, database_query/*
   */
  async archivePage(pageId: string): Promise<any> {
    const result = await this.request("PATCH", `/pages/${pageId}`, { archived: true });
    cache.invalidate(createCacheKey("page", { id: pageId }));
    cache.invalidatePattern(/^search/);
    cache.invalidatePattern(/^database_query/);
    return result;
  }

  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  /** Gets database schema and properties. @cached TTL: 15 minutes */
  async getDatabase(databaseId: string): Promise<any> {
    const cacheKey = createCacheKey("database", { id: databaseId });
    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `/databases/${databaseId}`),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Queries a database with filters and sorts.
   *
   * @param databaseId - Database ID to query
   * @param options - Query options
   * @param options.filter - Notion filter object
   * @param options.sorts - Array of sort objects
   * @param options.pageSize - Max results (max 100)
   * @param options.startCursor - Pagination cursor
   * @returns Query results with matching pages
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * await client.queryDatabase(dbId, {
   *   filter: { property: "Status", status: { equals: "Done" } },
   *   sorts: [{ property: "Created", direction: "descending" }]
   * });
   */
  async queryDatabase(
    databaseId: string,
    options?: {
      filter?: any;
      sorts?: any[];
      pageSize?: number;
      startCursor?: string;
    }
  ): Promise<any> {
    const cacheKey = createCacheKey("database_query", {
      id: databaseId,
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
        return this.request("POST", `/databases/${databaseId}/query`, body);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Creates a new row in a database.
   * Convenience wrapper around createPage.
   *
   * @param databaseId - Database ID
   * @param properties - Row properties
   * @returns Created page details
   */
  async createDatabaseRow(
    databaseId: string,
    properties: Record<string, any>
  ): Promise<any> {
    return this.createPage({ database_id: databaseId }, properties);
  }

  // ============================================
  // BLOCK OPERATIONS
  // ============================================

  /** Gets a single block by ID. @cached TTL: 15 minutes */
  async getBlock(blockId: string): Promise<any> {
    const cacheKey = createCacheKey("block", { id: blockId });
    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `/blocks/${blockId}`),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Appends blocks to a page or block.
   *
   * @param blockId - Parent block or page ID
   * @param children - Block objects to append
   * @returns Appended block details
   *
   * @invalidates blocks/{blockId}
   */
  async appendBlocks(blockId: string, children: any[]): Promise<any> {
    const result = await this.request("PATCH", `/blocks/${blockId}/children`, { children });
    cache.invalidate(createCacheKey("blocks", { id: blockId }));
    return result;
  }

  /**
   * Deletes a block.
   *
   * @param blockId - Block ID to delete
   * @returns Deleted block details
   *
   * @invalidates block/{blockId}, blocks/*{blockId}*
   */
  async deleteBlock(blockId: string): Promise<any> {
    const result = await this.request("DELETE", `/blocks/${blockId}`);
    cache.invalidate(createCacheKey("block", { id: blockId }));
    cache.invalidatePattern(new RegExp(`^blocks.*${blockId}`));
    return result;
  }

  // ============================================
  // USER OPERATIONS
  // ============================================

  /**
   * Lists workspace users.
   *
   * @param options - Pagination options
   * @returns User list
   *
   * @cached TTL: 1 hour
   */
  async listUsers(options?: {
    startCursor?: string;
    pageSize?: number;
  }): Promise<any> {
    const cacheKey = createCacheKey("users", options || {});
    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params = new URLSearchParams();
        if (options?.startCursor) params.set("start_cursor", options.startCursor);
        if (options?.pageSize) params.set("page_size", String(options.pageSize));
        const query = params.toString() ? `?${params.toString()}` : "";
        return this.request("GET", `/users${query}`);
      },
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /** Gets a user by ID. @cached TTL: 1 hour */
  async getUser(userId: string): Promise<any> {
    const cacheKey = createCacheKey("user", { id: userId });
    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `/users/${userId}`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /** Gets the bot user (integration). @cached TTL: 1 hour */
  async getSelf(): Promise<any> {
    return cache.getOrFetch(
      "self",
      () => this.request("GET", "/users/me"),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // COMMENT OPERATIONS
  // ============================================

  /**
   * Gets comments on a block or page.
   *
   * @param options - Query options
   * @param options.blockId - Block or page ID
   * @param options.startCursor - Pagination cursor
   * @param options.pageSize - Max results
   * @returns Comment list
   *
   * @cached TTL: 5 minutes
   */
  async getComments(options: {
    blockId?: string;
    startCursor?: string;
    pageSize?: number;
  }): Promise<any> {
    const cacheKey = createCacheKey("comments", options);
    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params = new URLSearchParams();
        if (options.blockId) params.set("block_id", options.blockId);
        if (options.startCursor) params.set("start_cursor", options.startCursor);
        if (options.pageSize) params.set("page_size", String(options.pageSize));
        return this.request("GET", `/comments?${params.toString()}`);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Creates a comment on a page or in a discussion.
   *
   * @param options - Comment options
   * @param options.parent - Page to comment on
   * @param options.discussion_id - Discussion thread ID
   * @param options.rich_text - Comment content
   * @returns Created comment details
   *
   * @invalidates comments/*{page_id}*
   */
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

  // ============================================
  // UTILITY
  // ============================================

  /**
   * Lists all databases the integration has access to.
   * Convenience wrapper around search with database filter.
   *
   * @returns All accessible databases
   *
   * @cached TTL: 5 minutes
   */
  async listDatabases(): Promise<any> {
    return cache.getOrFetch(
      "databases_list",
      () => this.search("", {
        filter: { property: "object", value: "database" },
      }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }
}

export default NotionClient;
