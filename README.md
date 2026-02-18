<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-notion

Notion workspace documentation and SOPs

![Version](https://img.shields.io/badge/version-1.1.10-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Search
- **search** — Search pages and databases
- Page
- **get-page** — Get a page by ID
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
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-notion.git
cd claude-code-plugin-notion
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js search
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

| Command  | Description                | Options                          |
| -------- | -------------------------- | -------------------------------- |
| `search` | Search pages and databases | `--query`, `--limit`, `--cursor` |

### Page Commands

| Command            | Description               | Options                                                                         |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------- |
| `get-page`         | Get a page by ID          | `--id` (required)                                                               |
| `get-page-content` | Get page content (blocks) | `--id` (required), `--limit`, `--cursor`                                        |
| `create-page`      | Create a new page         | `--parent-page` or `--parent-database`, `--title`, `--properties`, `--children` |
| `update-page`      | Update page properties    | `--id` (required), `--properties`                                               |
| `archive-page`     | Archive (delete) a page   | `--id` (required)                                                               |

### Database Commands

| Command               | Description                   | Options                                                         |
| --------------------- | ----------------------------- | --------------------------------------------------------------- |
| `get-database`        | Get database schema           | `--id` (required)                                               |
| `query-database`      | Query database rows           | `--id` (required), `--filter`, `--sorts`, `--limit`, `--cursor` |
| `create-database-row` | Create a row in a database    | `--id` (required), `--properties`                               |
| `list-databases`      | List all accessible databases | (none)                                                          |

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

| Option                | Description                              |
| --------------------- | ---------------------------------------- |
| `--id <id>`           | Notion page, database, block, or user ID |
| `--query <text>`      | Search query text                        |
| `--limit <number>`    | Maximum records to return                |
| `--cursor <cursor>`   | Pagination cursor for next page          |
| `--filter <json>`     | Filter as JSON string                    |
| `--sorts <json>`      | Sorts as JSON array string               |
| `--properties <json>` | Properties as JSON string                |
| `--children <json>`   | Block children as JSON array string      |

## Usage Examples

```bash
# Search for pages
npx tsx /Users/USER/node scripts/cli.ts search --query "regulatory registration"

# List all accessible databases
npx tsx /Users/USER/node scripts/cli.ts list-databases

# Get a specific page
npx tsx /Users/USER/node scripts/cli.ts get-page --id "abc123..."

# Get page content (blocks)
npx tsx /Users/USER/node scripts/cli.ts get-page-content --id "abc123..."

# Query a database
npx tsx /Users/USER/node scripts/cli.ts query-database --id "abc123..." --limit 10

# Create a new page
npx tsx /Users/USER/node scripts/cli.ts create-page --parent-page "abc123..." --title "New Page"

# List workspace users
npx tsx /Users/USER/node scripts/cli.ts list-users
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
