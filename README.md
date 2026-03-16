# ClawKit CLI

ClawKit is a Next.js-like framework CLI for AI agents.

## MVP Features

- `npx create-clawkit my-agent` project scaffolding
- Local vector memory with SQLite + embeddings
- Web search tool with **Brave API** and graylist domain security
  - `green`: trusted
  - `gray`: flagged
  - `red`: blocked
- Audit logging to `logs/audit.jsonl`
- Single-file agent config in `agent.ts`
- Hot reload on config changes
- Verbose mode with `--verbose`

## Prerequisites

- Node.js >= 18.17
- **Brave Search API key** ([get one here](https://brave.com/search/api/))

## Quick Start

```bash
# Set your Brave API key
export BRAVE_API_KEY="your-api-key"

# Scaffold a new agent
npx create-clawkit my-agent

cd my-agent

# Run local dev runtime with hot reload
npx clawkit dev --verbose
```

## CLI Usage

```bash
# Scaffold
create-clawkit <project-name>

# Run runtime in current directory
clawkit dev

# One-shot query
clawkit dev --query "/search node.js sqlite"

# Custom config path
clawkit dev --config ./agent.ts --verbose
```

## Agent Config (`agent.ts`)

```ts
const agent = {
  name: 'my-agent',
  instructions: 'You are a helpful AI agent built with ClawKit.',
  memory: {
    dbPath: './memory/memory.db',
    dimensions: 128,
  },
  search: {
    enabled: true,
    allowGray: true,
    maxResults: 5,
    graylistPath: './security/graylist.json',
  },
};

export default agent;
```

## Dev Shell Commands

- `/search <query>` — web search with domain graylist checks (uses Brave API)
- `/remember <text>` — store memory locally in SQLite
- `/recall <query>` — semantic memory lookup
- `/help` — command reference
- `/exit` — exit shell

## Graylist Security

Domains are classified into tiers:
- **Green** — trusted sources (e.g., github.com, openai.com)
- **Gray** — flagged, user warned (e.g., reddit.com, medium.com)
- **Red** — blocked (malware, phishing)

Customize in `security/graylist.json`.

## Development

```bash
npm install
npm run build
node dist/cli.js --help
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BRAVE_API_KEY` | Brave Search API key | Yes, for search |
