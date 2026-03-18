# Phase 6: Enterprise Skills

**Duration:** 2 weeks
**Priority:** P1
**Depends on:** Phase 4 (orchestrator + sandbox)

## Goal

Build the database querying tool (guardrailed bash tool) and the report generation skill. Database querying is NOT a separate package -- it is a guardrailed tool available inside the sandbox. Report generation is a modular skill package.

## Database Querying (Guardrailed Bash Tool)

Database querying is implemented as a **guardrailed tool** that the agent uses inside its sandbox. It is NOT a separate `packages/skills/database/` package. Connection details are injected as environment variables by the orchestrator.

### How It Works

1. The `connections` table in OpenZosma stores database connection configs (encrypted credentials)
2. When a session is created with database access enabled, the orchestrator decrypts credentials and injects them as env vars into the sandbox via OpenShell's credential provider
3. Inside the sandbox, the agent's bash tool can execute database queries using CLI tools (`psql`, `mysql`, `mongosh`, etc.) or the guardrailed query tool
4. SQL is parsed before execution to enforce read-only constraints

### Environment Variables

Injected by the orchestrator into the sandbox:

```bash
# Single database connection
DB_TYPE=postgresql          # postgresql, mysql, mongodb, clickhouse, bigquery, sqlite
DB_HOST=db.example.com
DB_PORT=5432
DB_NAME=analytics
DB_USER=readonly
DB_PASS=***

# Or as a connection string
DB_CONNECTION_STRING=postgresql://readonly:***@db.example.com:5432/analytics

# Multiple connections (numbered)
DB_1_TYPE=postgresql
DB_1_NAME=primary_db
DB_1_HOST=pg.example.com
DB_1_PORT=5432
DB_1_DB=analytics
DB_1_USER=readonly
DB_1_PASS=***

DB_2_TYPE=mongodb
DB_2_NAME=logs_db
DB_2_HOST=mongo.example.com
DB_2_PORT=27017
DB_2_DB=logs
DB_2_USER=readonly
DB_2_PASS=***
```

### Query Guardrails

The tool parses SQL before execution and enforces strict safety rules:

**SQL databases (PostgreSQL, MySQL, ClickHouse, BigQuery, SQLite):**
- Only `SELECT`, `WITH...SELECT`, `EXPLAIN` allowed
- Blocked: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`
- `LIMIT` appended if missing (configurable, default 1000 rows)
- Statement timeout enforced (configurable, default 30 seconds)
- Parameterized queries when possible

**MongoDB:**
- Only `find`, `aggregate`, `countDocuments` allowed
- Blocked: `insert`, `update`, `delete`, `drop`, `createCollection`, `createIndex`
- Result limit enforced

### Implementation

The guardrailed query tool is a lightweight script installed in the sandbox image. It reads connection details from env vars and exposes a CLI:

```bash
# Usage inside sandbox (called by the agent's bash tool)
db-query --connection primary_db --query "SELECT * FROM orders WHERE created_at > '2025-01-01' LIMIT 10"
db-query --connection logs_db --query '{"collection":"events","pipeline":[{"$match":{"level":"error"}}]}'
db-schema --connection primary_db
db-schema --connection primary_db --table orders
```

```typescript
// infra/openshell/tools/db-query.ts
// Installed in sandbox image at /usr/local/bin/db-query

import { parseSQL } from "./sql-parser.js"

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const conn = resolveConnection(args.connection)  // reads DB_* env vars

  // 1. Parse and validate query
  const parsed = parseSQL(args.query)
  if (!parsed.isReadOnly) {
    console.error(`Blocked: ${parsed.statementType} queries are not allowed. Only SELECT/WITH...SELECT/EXPLAIN permitted.`)
    process.exit(1)
  }

  // 2. Apply limits
  let query = args.query
  if (!parsed.hasLimit) {
    query += ` LIMIT ${conn.rowLimit ?? 1000}`
  }

  // 3. Execute with timeout
  const result = await executeQuery(conn, query, {
    timeout: conn.queryTimeout ?? 30000,
  })

  // 4. Output as JSON
  console.log(JSON.stringify({
    rows: result.rows,
    rowCount: result.rowCount,
    executionTimeMs: result.executionTimeMs,
  }, null, 2))
}
```

### Schema Introspection

```bash
# Agent calls this to discover available tables
db-schema --connection primary_db
```

Output:
```json
{
  "tables": [
    {
      "name": "orders",
      "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "primaryKey": true },
        { "name": "customer_id", "type": "uuid", "nullable": false },
        { "name": "total", "type": "numeric(10,2)", "nullable": false },
        { "name": "created_at", "type": "timestamptz", "nullable": false }
      ],
      "indexes": [
        { "name": "orders_pkey", "columns": ["id"], "unique": true },
        { "name": "idx_orders_customer", "columns": ["customer_id"], "unique": false }
      ],
      "approximateRowCount": 125000
    }
  ]
}
```

The schema output is designed to be included in the agent's system prompt so the agent knows what data is available.

### Supported Databases

| Database | CLI Tool | Driver (for db-query) |
|---|---|---|
| PostgreSQL | `psql` | `pg` |
| MySQL / MariaDB | `mysql` | `mysql2` |
| MongoDB | `mongosh` | `mongodb` |
| ClickHouse | `clickhouse-client` | `@clickhouse/client` |
| BigQuery | `bq` | `@google-cloud/bigquery` |
| SQLite | `sqlite3` | `better-sqlite3` |

### Sandbox Image Updates

The sandbox Docker image includes database CLI tools and the guardrailed query script:

```dockerfile
# Added to infra/openshell/Dockerfile
RUN apt-get update && apt-get install -y \
    postgresql-client \
    default-mysql-client \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Install db-query and db-schema tools
COPY tools/db-query.js /usr/local/bin/db-query
COPY tools/db-schema.js /usr/local/bin/db-schema
RUN chmod +x /usr/local/bin/db-query /usr/local/bin/db-schema
```

### Connection Management Flow

```
1. Admin configures connection in dashboard (/connections/new)
2. Connection stored in `connections` table (credentials AES-256-GCM encrypted)
3. Session created with database skill enabled
4. Orchestrator reads connections, decrypts credentials
5. Injects as DB_* env vars via OpenShell credential provider
6. Agent inside sandbox uses db-query/db-schema tools
7. Tools read env vars, validate query, execute, return results
```

## Report Skill (`packages/skills/reports/`)

Report generation is a proper skill package. It registers tools that agents can use to generate PDFs, presentations, charts, and data exports.

### Two Approaches

Both are supported simultaneously. The agent decides which to use based on the user's request.

### A) Template-Based Reports

Agent produces structured JSON matching a template schema. The skill renders it into PDF/PPTX/charts.

**Tools:**

**`report_list_templates`** -- List available report templates:
```typescript
{
  name: "report_list_templates",
  description: "List available report templates with their schemas.",
  parameters: {}
}
```

**`report_generate`** -- Generate a report from template + data:
```typescript
{
  name: "report_generate",
  description: "Generate a report from a template and structured data. Returns a file path to the generated report.",
  parameters: {
    template: "string - template name",
    format: "string - output format: pdf, pptx, png, svg",
    data: "object - structured data matching the template schema",
  }
}
```

**Template example (monthly report):**

```typescript
interface MonthlyReportData {
  title: string
  period: { from: string; to: string }
  summary: { metric: string; value: number; change: number }[]
  charts: {
    type: "bar" | "line" | "pie"
    title: string
    data: { label: string; value: number }[]
  }[]
  tables: {
    title: string
    headers: string[]
    rows: (string | number)[][]
  }[]
}
```

**Rendering stack:**
- **PDF:** React-PDF (`@react-pdf/renderer`) -- renders React components to PDF
- **PPTX:** pptxgenjs -- programmatic PowerPoint generation
- **Charts:** chart.js with `chartjs-node-canvas` (server-side rendering to PNG/SVG)

### B) Agent-Generated Code Reports

Agent writes code that generates visualizations. Code runs inside the sandbox.

**Tools:**

**`report_execute_code`** -- Run code to generate a report/chart:
```typescript
{
  name: "report_execute_code",
  description: "Execute Python or JavaScript code to generate charts, reports, or data visualizations. The code should save output to /workspace/output/. Returns file paths to generated files.",
  parameters: {
    language: "string - python or javascript",
    code: "string - code to execute",
    dependencies: "string[]? - additional packages to install (pip/npm)",
  }
}
```

**Available libraries in sandbox:**

Python (pre-installed in sandbox image):
- `matplotlib` -- charts and plots
- `pandas` -- data manipulation
- `numpy` -- numerical computation
- `seaborn` -- statistical visualization (optional)

JavaScript (available via npm):
- `chart.js` + `chartjs-node-canvas` -- charts
- `d3` -- data visualization (SVG)

**Execution:**
```typescript
async function executeReportCode(params: {
  language: "python" | "javascript"
  code: string
  dependencies?: string[]
}): Promise<{ files: string[] }> {
  // 1. Install additional dependencies if requested
  if (params.dependencies?.length) {
    if (params.language === "python") {
      await exec(`pip3 install ${params.dependencies.join(" ")}`)
    } else {
      await exec(`npm install ${params.dependencies.join(" ")}`)
    }
  }

  // 2. Write code to temp file
  const ext = params.language === "python" ? "py" : "js"
  const scriptPath = `/workspace/output/report_script.${ext}`
  await writeFile(scriptPath, params.code)

  // 3. Execute
  const runtime = params.language === "python" ? "python3" : "node"
  const result = await exec(`${runtime} ${scriptPath}`, {
    timeout: 60000,  // 60s max
    cwd: "/workspace/output",
  })

  // 4. Find generated files
  const files = await glob("/workspace/output/*.{png,svg,pdf,pptx,csv,xlsx}")

  return { files, stdout: result.stdout, stderr: result.stderr }
}
```

### Output Formats

| Format | Template-Based | Code-Generated |
|---|---|---|
| PDF | React-PDF | matplotlib/reportlab |
| PPTX | pptxgenjs | python-pptx |
| PNG | chart.js canvas | matplotlib/chart.js |
| SVG | chart.js canvas | matplotlib/D3 |
| CSV | built-in | pandas |
| XLSX | exceljs | openpyxl |

### File Delivery

Generated files are saved to `/workspace/output/` inside the sandbox. The orchestrator:
1. Copies files out of the sandbox via `openshell sandbox cp`
2. Uploads to temporary storage (S3-compatible or local filesystem)
3. Returns download URLs to the user via the agent's response

For channel adapters:
- **Web:** Download link in chat
- **Slack:** File upload to thread
- **WhatsApp:** Media message (document or image)

## Deliverables

1. **Database querying tool** (installed in sandbox image, NOT a separate package)
   - `db-query` CLI with SQL parsing and read-only enforcement
   - `db-schema` CLI for schema introspection
   - Support for PostgreSQL, MySQL, MongoDB, ClickHouse, BigQuery, SQLite
   - Query timeout and row limit enforcement
2. **Report skill** (`packages/skills/reports/`)
   - Template engine (React-PDF, pptxgenjs, chart.js)
   - Built-in templates (monthly report, data summary, dashboard)
   - Code execution for ad-hoc reports
   - File output handling
3. Sandbox image updated with database CLIs, Python, and report dependencies
4. Orchestrator updated to inject DB credentials as env vars
5. Tests (query execution against test databases, report rendering)
