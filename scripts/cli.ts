#!/usr/bin/env npx tsx
/**
 * Notion Workspace Manager CLI
 *
 * Zod-validated CLI for Notion workspace operations.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { NotionClient } from "./notion-client.js";

// Helper for JSON parsing
function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON: ${value}`);
  }
}

// Define commands with Zod schemas
const commands = {
  // ==================== Search ====================
  "search": createCommand(
    z.object({
      query: z.string().optional().describe("Search query"),
      filter: z.string().optional().describe("Filter as JSON string"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
    }),
    async (args, client: NotionClient) => {
      const { query, filter, cursor, limit } = args as {
        query?: string; filter?: string; cursor?: string; limit?: number;
      };
      return client.search(query || "", {
        filter: parseJson(filter) as Record<string, unknown> | undefined,
        startCursor: cursor,
        pageSize: limit,
      });
    },
    "Search pages and databases"
  ),

  // ==================== Pages ====================
  "get-page": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return client.getPage(id);
    },
    "Get a page by ID"
  ),

  "get-page-content": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max blocks"),
    }),
    async (args, client: NotionClient) => {
      const { id, cursor, limit } = args as { id: string; cursor?: string; limit?: number };
      return client.getBlocks(id, { startCursor: cursor, pageSize: limit });
    },
    "Get page content (blocks)"
  ),

  "create-page": createCommand(
    z.object({
      parentPage: z.string().optional().describe("Parent page ID"),
      parentDatabase: z.string().optional().describe("Parent database ID"),
      title: z.string().optional().describe("Page title"),
      properties: z.string().optional().describe("Properties as JSON string"),
      children: z.string().optional().describe("Block children as JSON array"),
    }).refine(
      (data) => data.parentPage !== undefined || data.parentDatabase !== undefined,
      { message: "Either --parent-page or --parent-database is required" }
    ),
    async (args, client: NotionClient) => {
      const { parentPage, parentDatabase, title, properties, children } = args as {
        parentPage?: string; parentDatabase?: string; title?: string;
        properties?: string; children?: string;
      };
      const parent: { database_id?: string; page_id?: string } = {};
      if (parentDatabase) {
        parent.database_id = parentDatabase;
      } else if (parentPage) {
        parent.page_id = parentPage;
      }

      let props = parseJson(properties) as Record<string, unknown> || {};
      if (title && !props.title) {
        props.title = { title: [{ text: { content: title } }] };
      }

      return client.createPage(parent, props, parseJson(children) as unknown[] | undefined);
    },
    "Create a new page"
  ),

  "update-page": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
      properties: z.string().min(1).describe("Properties as JSON string"),
    }),
    async (args, client: NotionClient) => {
      const { id, properties } = args as { id: string; properties: string };
      return client.updatePage(id, parseJson(properties) as Record<string, unknown>);
    },
    "Update page properties"
  ),

  "archive-page": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return client.archivePage(id);
    },
    "Archive (delete) a page"
  ),

  // ==================== Databases ====================
  "get-database": createCommand(
    z.object({
      id: z.string().min(1).describe("Database ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return client.getDatabase(id);
    },
    "Get database schema"
  ),

  "query-database": createCommand(
    z.object({
      id: z.string().min(1).describe("Database ID"),
      filter: z.string().optional().describe("Filter as JSON string"),
      sorts: z.string().optional().describe("Sorts as JSON array"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
    }),
    async (args, client: NotionClient) => {
      const { id, filter, sorts, cursor, limit } = args as {
        id: string; filter?: string; sorts?: string; cursor?: string; limit?: number;
      };
      return client.queryDatabase(id, {
        filter: parseJson(filter) as Record<string, unknown> | undefined,
        sorts: parseJson(sorts) as unknown[] | undefined,
        startCursor: cursor,
        pageSize: limit,
      });
    },
    "Query database rows"
  ),

  "create-database-row": createCommand(
    z.object({
      id: z.string().min(1).describe("Database ID"),
      properties: z.string().min(1).describe("Properties as JSON string"),
    }),
    async (args, client: NotionClient) => {
      const { id, properties } = args as { id: string; properties: string };
      return client.createDatabaseRow(id, parseJson(properties) as Record<string, unknown>);
    },
    "Create a row in a database"
  ),

  "list-databases": createCommand(
    z.object({}),
    async (_args, client: NotionClient) => client.listDatabases(),
    "List all accessible databases"
  ),

  // ==================== Blocks ====================
  "get-block": createCommand(
    z.object({
      id: z.string().min(1).describe("Block ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return client.getBlock(id);
    },
    "Get a block by ID"
  ),

  "append-blocks": createCommand(
    z.object({
      id: z.string().min(1).describe("Page or block ID"),
      children: z.string().min(1).describe("Block children as JSON array"),
    }),
    async (args, client: NotionClient) => {
      const { id, children } = args as { id: string; children: string };
      return client.appendBlocks(id, parseJson(children) as unknown[]);
    },
    "Append blocks to a page/block"
  ),

  "delete-block": createCommand(
    z.object({
      id: z.string().min(1).describe("Block ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return client.deleteBlock(id);
    },
    "Delete a block"
  ),

  // ==================== Users ====================
  "list-users": createCommand(
    z.object({
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
    }),
    async (args, client: NotionClient) => {
      const { cursor, limit } = args as { cursor?: string; limit?: number };
      return client.listUsers({ startCursor: cursor, pageSize: limit });
    },
    "List workspace users"
  ),

  "get-user": createCommand(
    z.object({
      id: z.string().min(1).describe("User ID"),
    }),
    async (args, client: NotionClient) => {
      const { id } = args as { id: string };
      return client.getUser(id);
    },
    "Get a user by ID"
  ),

  "get-self": createCommand(
    z.object({}),
    async (_args, client: NotionClient) => client.getSelf(),
    "Get the bot user info"
  ),

  // ==================== Comments ====================
  "get-comments": createCommand(
    z.object({
      id: z.string().min(1).describe("Page or block ID"),
      cursor: z.string().optional().describe("Pagination cursor"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
    }),
    async (args, client: NotionClient) => {
      const { id, cursor, limit } = args as { id: string; cursor?: string; limit?: number };
      return client.getComments({ blockId: id, startCursor: cursor, pageSize: limit });
    },
    "Get comments on a page/block"
  ),

  "create-comment": createCommand(
    z.object({
      id: z.string().min(1).describe("Page ID"),
      text: z.string().min(1).describe("Comment text"),
    }),
    async (args, client: NotionClient) => {
      const { id, text } = args as { id: string; text: string };
      return client.createComment({
        parent: { page_id: id },
        rich_text: [{ text: { content: text } }],
      });
    },
    "Create a comment"
  ),

  // Pre-built cache commands
  ...cacheCommands<NotionClient>(),
};

// Run CLI
runCli(commands, NotionClient, {
  programName: "notion-cli",
  description: "Notion workspace operations",
});
