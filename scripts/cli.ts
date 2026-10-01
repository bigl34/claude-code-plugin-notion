#!/usr/bin/env npx tsx

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z, createCommand, runCli, cacheCommands, cliTypes, buildSafeOutput } from "@local/cli-utils";
import { NotionClient } from "./notion-client.js";
import {
  canonicalizeNotionUrl,
  createWrapStats,
  flattenNotionBlocksDepthFirstWithTruncation,
  notionBlockView,
  notionCommentView,
  notionDatabaseView,
  notionPageTitle,
  notionPageView,
  notionResponseBudget,
  notionRowView,
  notionSearchItemView,
  notionUserView,
  notionWriteEcho,
  wrapStatsNotes,
  type WrapStats,
} from "./notion-wrap.js";

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON: ${value}`);
  }
}

function finalizeEnvelope(
  metadata: Record<string, unknown>,
  content: Record<string, unknown>,
  stats: WrapStats,
): ReturnType<typeof buildSafeOutput> {
  const notes = wrapStatsNotes(stats);
  const measured = notionResponseBudget(content);
  if (measured.withinBudget) {
    return buildSafeOutput({ ...metadata, response_bytes: measured.bytes }, content, notes);
  }

  const stripped = stripPayloads(content);
  const strippedMeasurement = notionResponseBudget(stripped);
  return buildSafeOutput(
    { ...metadata, response_bytes: strippedMeasurement.bytes, payload_omitted: true },
    stripped,
    [
      ...notes,
      `payload omitted: ${measured.violations.join("; ")}. `
        + "Re-run with a smaller --limit, or fetch the object directly with get-page / get-database / get-block.",
    ],
  );
}

let databaseTitleMap: Promise<Map<string, string> | null> | undefined;

function loadDatabaseTitleMap(client: NotionClient): Promise<Map<string, string> | null> {
  if (!databaseTitleMap) {
    databaseTitleMap = client
      .listDatabases()
      .then((response: { results?: Array<Record<string, unknown>> }) => {
        const map = new Map<string, string>();
        for (const database of response.results ?? []) {
          const id = typeof database.id === "string" ? database.id.replace(/-/g, "") : "";
          if (id) map.set(id, notionPageTitle(database));
        }
        return map;
      })
      .catch(() => null);
  }
  return databaseTitleMap;
}

export function resetDatabaseTitleMap(): void {
  databaseTitleMap = undefined;
}

function stripPayloads(content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (key === "payload") continue;
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([k]) => k !== "payload"))
          : item,
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

export const commands = {
  "search": createCommand(
    z.object({
      query: z.string().optional().describe("Search query"),
      filter: z.string().optional().describe("Filter as JSON string"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
      sort: z.string().optional().describe("Sort spec, e.g. last_edited_time:descending"),
      payload: z.boolean().optional().describe("Include the full wrapped Notion object per result"),
    }),
    async (args, client: NotionClient) => {
      const { query, filter, cursor, limit, sort, payload } = args as {
        query?: string; filter?: string; cursor?: string; limit?: number; sort?: string; payload?: boolean;
      };
      let sortObject: { timestamp: string; direction: "ascending" | "descending" } | undefined;
      if (sort) {
        const [timestamp, direction] = sort.split(":");
        if (!timestamp || (direction !== "ascending" && direction !== "descending")) {
          throw new Error(`Invalid --sort value "${sort}". Expected "<timestamp>:ascending" or "<timestamp>:descending".`);
        }
        sortObject = { timestamp, direction };
      }

      const raw = await client.search(query || "", {
        filter: parseJson(filter) as { property: string; value: string } | undefined,
        startCursor: cursor,
        pageSize: limit,
        sort: sortObject,
      });

      const items = (raw.results ?? []) as Array<Record<string, any>>;
      const needsParentTitles = items.some((item) => item?.parent?.type === "database_id");
      const titles = needsParentTitles ? await loadDatabaseTitleMap(client) : new Map<string, string>();

      const stats = createWrapStats();
      const results = items.map((item) => {
        const parentDatabaseId = item?.parent?.type === "database_id" && typeof item.parent.database_id === "string"
          ? item.parent.database_id.replace(/-/g, "")
          : undefined;
        const view = notionSearchItemView(item, {
          stats,
          fieldPrefix: "results[].",
          includePayload: payload === true,
          parentDatabaseTitle: parentDatabaseId && titles ? titles.get(parentDatabaseId) : undefined,
        });
        if (parentDatabaseId && !titles) {
          view.parent_database_title_unavailable = true;
        }
        return view;
      });

      return finalizeEnvelope(
        {
          command: "search",
          count: results.length,
          has_more: raw.has_more,
          next_cursor: raw.next_cursor,
          parent_titles_resolved: needsParentTitles ? titles !== null : true,
        },
        { results },
        stats,
      );
    },
    "Search pages and databases",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-page": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      const page = await client.getPage(id);
      const stats = createWrapStats();
      const view = notionPageView(page, { stats });
      return finalizeEnvelope(
        {
          command: "get-page",
          page_id: page.id,
          url: canonicalizeNotionUrl(page.url) ?? undefined,
          created_time: page.created_time,
          last_edited_time: page.last_edited_time,
          archived: page.archived,
          parent: page.parent
            ? {
                type: page.parent.type,
                database_id: page.parent.database_id,
                page_id: page.parent.page_id,
                workspace: page.parent.workspace,
                block_id: page.parent.block_id,
              }
            : undefined,
        },
        view,
        stats,
      );
    },
    "Get a page by ID",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-page-content": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max blocks"),
      depth: cliTypes.int(0, 5).optional().describe(
        "Max recursion depth for nested block children (0=flat, 1=direct children; 5=max)"
      ),
    }),
    async (args, client: NotionClient) => {
      const { id, cursor, limit, depth } = args as { id: string; cursor?: string; limit?: number; depth?: number };
      const raw = await client.getBlocks(id, { startCursor: cursor, pageSize: limit });

      const expanded = await flattenNotionBlocksDepthFirstWithTruncation(raw.results ?? [], {
        parentId: id,
        maxDepth: depth ?? 0,
        maxBlocks: limit,
        fetchChildren: (blockId, options) => client.getBlocks(blockId, options),
      });

      const stats = createWrapStats();
      const blocks = expanded.blocks.map((block: Record<string, unknown>) =>
        notionBlockView(block, { stats, fieldPrefix: "blocks[]." }),
      );
      const truncation = expanded.truncated ? { truncated: true } : {};

      return finalizeEnvelope(
        { command: "get-page-content", page_id: id, count: blocks.length, has_more: raw.has_more, next_cursor: raw.next_cursor, ...truncation },
        { blocks },
        stats,
      );
    },
    "Get page content (blocks). Use --depth to recursively expand nested children.",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "create-page": createCommand(
    z.object({
      parentPage: z.string().optional().describe("Parent page ID"),
      parentDatabase: z.string().optional().describe("Parent database ID"),
      parentDataSource: z.string().optional().describe("Explicit parent data source ID (current API)"),
      title: z.string().optional().describe("Page title"),
      properties: z.string().optional().describe("Properties as JSON string"),
      children: z.string().optional().describe("Block children as JSON array"),
    }).refine(
      (data) => [data.parentPage, data.parentDatabase, data.parentDataSource]
        .filter((value) => value !== undefined).length === 1,
      { message: "Exactly one of --parent-page, --parent-database, or --parent-data-source is required" }
    ),
    async (args, client: NotionClient) => {
      const { parentPage, parentDatabase, parentDataSource, title, properties, children } = args as {
        parentPage?: string; parentDatabase?: string; parentDataSource?: string; title?: string;
        properties?: string; children?: string;
      };
      const parent: { database_id?: string; data_source_id?: string; page_id?: string } = {};
      if (parentDataSource) {
        parent.data_source_id = parentDataSource;
      } else if (parentDatabase) {
        parent.database_id = parentDatabase;
      } else if (parentPage) {
        parent.page_id = parentPage;
      }

      const props = parseJson(properties) as Record<string, unknown> || {};
      if (title && !props.title) {
        props.title = { title: [{ text: { content: title } }] };
      }

      const created = await client.createPage(parent, props, parseJson(children) as unknown[] | undefined);
      return writeEchoEnvelope("create-page", created);
    },
    "Create a new page",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  "update-page": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
      properties: z.string().min(1).describe("Properties as JSON string"),
    }),
    async (args, client: NotionClient) => {
      const { id, properties } = args as { id: string; properties: string };
      const updated = await client.updatePage(id, parseJson(properties) as Record<string, unknown>);
      return writeEchoEnvelope("update-page", updated);
    },
    "Update page properties",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  "archive-page": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return writeEchoEnvelope("archive-page", await client.archivePage(id));
    },
    "Archive (delete) a page",
    { sideEffect: "destructive", requiresSafeOutput: true }
  ),

  "get-database": createCommand(
    z.object({
      id: z.string().min(1).optional().describe("Database container ID"),
      dataSource: z.string().min(1).optional().describe("Explicit data source ID"),
    }).refine((data) => [data.id, data.dataSource].filter((value) => value !== undefined).length === 1, {
      message: "Exactly one of --id or --data-source is required",
    }),
    async (args, client: NotionClient) => {
      const { id, dataSource } = args as { id?: string; dataSource?: string };
      const db = (await client.getDatabase(id, { dataSourceId: dataSource })) as Record<string, unknown>;
      const stats = createWrapStats();
      return finalizeEnvelope({ command: "get-database" }, notionDatabaseView(db, { stats }), stats);
    },
    "Get database schema",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "query-database": createCommand(
    z.object({
      id: z.string().min(1).optional().describe("Database container ID"),
      dataSource: z.string().min(1).optional().describe("Explicit data source ID"),
      filter: z.string().optional().describe("Filter as JSON string"),
      sorts: z.string().optional().describe("Sorts as JSON array"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
      payload: z.boolean().optional().describe("Include the full wrapped Notion object per row"),
    }).refine((data) => [data.id, data.dataSource].filter((value) => value !== undefined).length === 1, {
      message: "Exactly one of --id or --data-source is required",
    }),
    async (args, client: NotionClient) => {
      const { id, dataSource, filter, sorts, cursor, limit, payload } = args as {
        id?: string; dataSource?: string; filter?: string; sorts?: string; cursor?: string; limit?: number; payload?: boolean;
      };
      const raw = (await client.queryDatabase(id, {
        dataSourceId: dataSource,
        filter: parseJson(filter) as Record<string, unknown> | undefined,
        sorts: parseJson(sorts) as unknown[] | undefined,
        startCursor: cursor,
        pageSize: limit,
      })) as { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };

      const stats = createWrapStats();
      const results = (raw.results ?? []).map((row) =>
        notionRowView(row as Record<string, unknown>, {
          stats,
          fieldPrefix: "results[].",
          includePayload: payload === true,
        }),
      );
      return finalizeEnvelope(
        {
          command: "query-database",
          count: results.length,
          has_more: raw.has_more ?? false,
          next_cursor: raw.next_cursor ?? null,
        },
        { results },
        stats,
      );
    },
    "Query database rows",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "create-database-row": createCommand(
    z.object({
      id: z.string().min(1).optional().describe("Database container ID"),
      dataSource: z.string().min(1).optional().describe("Explicit data source ID"),
      properties: z.string().min(1).describe("Properties as JSON string"),
    }).refine((data) => [data.id, data.dataSource].filter((value) => value !== undefined).length === 1, {
      message: "Exactly one of --id or --data-source is required",
    }),
    async (args, client: NotionClient) => {
      const { id, dataSource, properties } = args as { id?: string; dataSource?: string; properties: string };
      const created = await client.createDatabaseRow(
        id,
        parseJson(properties) as Record<string, unknown>,
        { dataSourceId: dataSource }
      );
      return writeEchoEnvelope("create-database-row", created);
    },
    "Create a row in a database",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  "list-databases": createCommand(
    z.object({
      payload: z.boolean().optional().describe("Include the full wrapped Notion object per database"),
    }),
    async (args, client: NotionClient) => {
      const { payload } = args as { payload?: boolean };
      const raw = (await client.listDatabases()) as {
        results?: unknown[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      const stats = createWrapStats();
      const results = (raw.results ?? []).map((db) =>
        notionDatabaseView(db as Record<string, unknown>, {
          stats,
          fieldPrefix: "results[].",
          includePayload: payload === true,
        }),
      );
      return finalizeEnvelope(
        {
          command: "list-databases",
          count: results.length,
          has_more: raw.has_more ?? false,
          next_cursor: raw.next_cursor ?? null,
        },
        { results },
        stats,
      );
    },
    "List all accessible databases",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "create-database": createCommand(
    z.object({
      parentPage: z.string().min(1).describe("Parent page ID hosting the new database"),
      title: z.string().min(1).describe("Database title"),
      properties: z.string().min(1).describe("Property schema map as JSON, e.g. {\"Status\":{\"select\":{\"options\":[...]}}}"),
    }),
    async (args, client: NotionClient) => {
      const { parentPage, title, properties } = args as { parentPage: string; title: string; properties: string };
      const props = parseJson(properties) as Record<string, unknown>;
      const created = await client.createDatabase(parentPage, title, props);
      return writeEchoEnvelope("create-database", created);
    },
    "Create a new database under a parent page",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  "update-database": createCommand(
    z.object({
      id: z.string().min(1).optional().describe("Database container ID"),
      dataSource: z.string().min(1).optional().describe("Explicit data source ID"),
      properties: z.string().min(1).describe("Property schema patch as JSON. Adding a property appends it as the right-most column; {\"Name\":null} removes one; {\"Old\":{\"name\":\"New\"}} renames one."),
    }).refine((data) => [data.id, data.dataSource].filter((value) => value !== undefined).length === 1, {
      message: "Exactly one of --id or --data-source is required",
    }),
    async (args, client: NotionClient) => {
      const { id, dataSource, properties } = args as { id?: string; dataSource?: string; properties: string };
      const updated = await client.updateDatabaseProperties(
        id,
        parseJson(properties) as Record<string, unknown>,
        { dataSourceId: dataSource }
      );
      return writeEchoEnvelope("update-database", updated);
    },
    "Add, remove or rename database properties (schema patch)",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  "get-block": createCommand(
    z.object({
      id: z.string().min(1).describe("Block ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      const block = (await client.getBlock(id)) as Record<string, unknown>;
      const stats = createWrapStats();
      return finalizeEnvelope({ command: "get-block" }, notionBlockView(block, { stats }), stats);
    },
    "Get a block by ID",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "append-blocks": createCommand(
    z.object({
      id: z.string().min(1).describe("Page or block ID"),
      children: z.string().min(1).describe("Block children as JSON array"),
      after: z.string().optional().describe("Insert children after this sibling block ID (Notion API 'after' param)"),
    }),
    async (args, client: NotionClient) => {
      const { id, children, after } = args as { id: string; children: string; after?: string };
      const appended = await client.appendBlocks(id, parseJson(children) as unknown[], { after });
      return writeEchoEnvelope("append-blocks", appended as Record<string, unknown>);
    },
    "Append blocks to a page/block",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  "delete-block": createCommand(
    z.object({
      id: z.string().min(1).describe("Block ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return writeEchoEnvelope("delete-block", await client.deleteBlock(id) as Record<string, unknown>);
    },
    "Delete a block",
    { sideEffect: "destructive", requiresSafeOutput: true }
  ),

  "update-block": createCommand(
    z.object({
      id: z.string().min(1).describe("Block ID"),
      payload: z.string().min(1).describe(
        "Update payload as JSON. Must be wrapped in the block-type key, " +
        "e.g. {\"paragraph\":{\"rich_text\":[{\"type\":\"text\",\"text\":{\"content\":\"...\"}}]}}"
      ),
    }),
    async (args, client: NotionClient) => {
      const { id, payload } = args as { id: string; payload: string };
      const parsed = parseJson(payload) as Record<string, unknown> | undefined;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("--payload must be a JSON object keyed by block type");
      }
      const updated = await client.updateBlock(id, parsed);
      return writeEchoEnvelope("update-block", updated);
    },
    "Update a block in place (atomic, preserves layout)",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  "list-users": createCommand(
    z.object({
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
      payload: z.boolean().optional().describe("Include the full wrapped Notion object per user"),
    }),
    async (args, client: NotionClient) => {
      const { cursor, limit, payload } = args as { cursor?: string; limit?: number; payload?: boolean };
      const raw = await client.listUsers({ startCursor: cursor, pageSize: limit });
      const stats = createWrapStats();
      const users = (raw.results ?? []).map((user: Record<string, unknown>) =>
        notionUserView(user, { stats, fieldPrefix: "users[].", includePayload: payload === true }),
      );
      return finalizeEnvelope(
        {
          command: "list-users",
          count: users.length,
          has_more: raw.has_more ?? false,
          next_cursor: raw.next_cursor ?? null,
        },
        { users },
        stats,
      );
    },
    "List workspace users",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-user": createCommand(
    z.object({
      id: z.string().min(1).describe("User ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      const stats = createWrapStats();
      const user = await client.getUser(id);
      return finalizeEnvelope({ command: "get-user", user_id: id }, notionUserView(user, { stats }), stats);
    },
    "Get a user by ID",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-self": createCommand(
    z.object({}),
    async (_args, client: NotionClient) => {
      const stats = createWrapStats();
      const self = await client.getSelf();
      return finalizeEnvelope({ command: "get-self" }, notionUserView(self, { stats }), stats);
    },
    "Get the bot user info",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-comments": createCommand(
    z.object({
      id: z.string().min(1).describe("Page or block ID"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
      payload: z.boolean().optional().describe("Include the full wrapped Notion object per comment"),
    }),
    async (args, client: NotionClient) => {
      const { id, cursor, limit, payload } = args as { id: string; cursor?: string; limit?: number; payload?: boolean };
      const raw = await client.getComments({ blockId: id, startCursor: cursor, pageSize: limit });

      const stats = createWrapStats();
      const comments = (raw.results ?? []).map((comment: Record<string, unknown>) =>
        notionCommentView(comment, { stats, fieldPrefix: "comments[].", includePayload: payload === true }),
      );

      return finalizeEnvelope(
        {
          command: "get-comments",
          target_id: id,
          count: comments.length,
          has_more: raw.has_more ?? false,
          next_cursor: raw.next_cursor ?? null,
        },
        { comments },
        stats,
      );
    },
    "Get comments on a page/block",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "create-comment": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
      text: z.string().min(1).describe("Comment text"),
    }),
    async (args, client: NotionClient) => {
      const { id, text } = args as { id: string; text: string };
      const created = await client.createComment({
        parent: { page_id: id },
        rich_text: [{ text: { content: text } }],
      });
      return writeEchoEnvelope("create-comment", created);
    },
    "Create a comment",
    { sideEffect: "write", requiresSafeOutput: true }
  ),

  ...cacheCommands<NotionClient>(),
};

function writeEchoEnvelope(command: string, response: Record<string, unknown> | undefined) {
  const stats = createWrapStats();
  const echo = notionWriteEcho(command, response, { stats });
  return finalizeEnvelope(echo.metadata, echo.content, stats);
}

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, NotionClient, {
    programName: "notion-cli",
    description: "Notion workspace operations",
  });
}

