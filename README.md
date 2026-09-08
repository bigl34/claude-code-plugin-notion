<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-notion

Notion workspace documentation and SOPs

![Version](https://img.shields.io/badge/version-1.5.0-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Search
- **search** — Search pages and databases
- Page
- **get-page** — Get a page by ID (metadata + flattened properties + full payload)
- **get-page-content** — Get page content (blocks)
- **create-page** — Create a new page
- **update-page** — Update page properties
- **archive-page** — Archive (delete) a page
- Database
- **get-database** — Get database schema
- **query-database** — Query database rows
- **create-database-row** — Create a row in a database
- **list-databases** — List all accessible databases
- Block
- **get-block** — Get a block by ID
- **append-blocks** — Append blocks to a page/block
- **delete-block** — Delete a block
- User
- **list-users** — List workspace users
- **get-user** — Get a user by ID
- **get-self** — Get bot user info
- Comment
- **get-comments** — Get comments on a page/block
- **create-comment** — Create a comment

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-notion.git
cd claude-code-plugin-notion
cp config.template.json config.json  # fill in your credentials
npm --prefix scripts install
```

```bash
npm --prefix scripts run cli -- search
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Available Commands

### Search Command

| Command  | Description                | Options                                                                             |
| -------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `search` | Search pages and databases | `--query`, `--limit`, `--cursor`, `--sort last_edited_time:descending`, `--payload` |

### Page Commands

| Command            | Description                                                       | Options                                                                                                         |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `get-page`         | Get a page by ID (metadata + flattened properties + full payload) | `--id` (required)                                                                                               |
| `get-page-content` | Get page content (blocks)                                         | `--id` (required), `--limit`, `--cursor`, `--depth 0-5`                                                         |
| `create-page`      | Create a new page                                                 | One of `--parent-page`, `--parent-database`, or `--parent-data-source`; `--title`, `--properties`, `--children` |
| `update-page`      | Update page properties                                            | `--id` (required), `--properties`                                                                               |
| `archive-page`     | Archive (delete) a page                                           | `--id` (required)                                                                                               |

### Database Commands

| Command               | Description                   | Options                                                                                                          |
| --------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `get-database`        | Get database schema           | One of `--id` (database container) or `--data-source`                                                            |
| `query-database`      | Query database rows           | One of `--id` (database container) or `--data-source`; `--filter`, `--sorts`, `--limit`, `--cursor`, `--payload` |
| `create-database-row` | Create a row in a database    | One of `--id` (database container) or `--data-source`; `--properties`                                            |
| `list-databases`      | List all accessible databases | `--payload`                                                                                                      |

### Block Commands

| Command         | Description                   | Options                         |
| --------------- | ----------------------------- | ------------------------------- |
| `get-block`     | Get a block by ID             | `--id` (required)               |
| `append-blocks` | Append blocks to a page/block | `--id` (required), `--children` |
| `delete-block`  | Delete a block                | `--id` (required)               |

### User Commands

| Command      | Description          | Options               |
| ------------ | -------------------- | --------------------- |
| `list-users` | List workspace users | `--limit`, `--cursor` |
| `get-user`   | Get a user by ID     | `--id` (required)     |
| `get-self`   | Get bot user info    | (none)                |

### Comment Commands

| Command          | Description                  | Options                                  |
| ---------------- | ---------------------------- | ---------------------------------------- |
| `get-comments`   | Get comments on a page/block | `--id` (required), `--limit`, `--cursor` |
| `create-comment` | Create a comment             | `--id` (required), `--text` (required)   |

### Common Options

| Option                      | Description                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--id <id>`                 | Notion page, database, block, or user ID                                                                           |
| `--data-source <id>`        | Explicit Notion data source ID for database schema, query, or row creation                                         |
| `--parent-data-source <id>` | Explicit parent data source ID when creating a database row with `create-page`                                     |
| `--query <text>`            | Search query text                                                                                                  |
| `--limit <number>`          | Maximum records to return                                                                                          |
| `--cursor <cursor>`         | Pagination cursor for next page                                                                                    |
| `--filter <json>`           | Filter as JSON string                                                                                              |
| `--sorts <json>`            | Sorts as JSON array string                                                                                         |
| `--properties <json>`       | Properties as JSON string                                                                                          |
| `--children <json>`         | Block children as JSON array string                                                                                |
| `--payload`                 | Include the full wrapped Notion object per result (multi-result reads only; single-object reads always include it) |

## Usage Examples

```bash
# Search for pages
npm --prefix "scripts" run cli -- search --query "regulatory registration"

# List all accessible databases
npm --prefix "scripts" run cli -- list-databases

# Get a specific page
npm --prefix "scripts" run cli -- get-page --id "abc123..."

# Get page content (blocks)
npm --prefix "scripts" run cli -- get-page-content --id "abc123..."

# Query a database
npm --prefix "scripts" run cli -- query-database --id "abc123..." --limit 10

# Query an explicit data source (required when a database has multiple sources)
npm --prefix "scripts" run cli -- query-database --data-source "def456..." --limit 10

# Create a new page
npm --prefix "scripts" run cli -- create-page --parent-page "abc123..." --title "New Page"

# List workspace users
npm --prefix "scripts" run cli -- list-users
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
