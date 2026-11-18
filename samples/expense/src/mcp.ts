import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP adapter for the expense sample. It holds no kernel. It calls the REST adapter as one actor,
 * so the same availability and sensitivity rules apply to agents as to people.
 */

type Json = Record<string, unknown>;

interface CommandView {
  readonly uri: string;
  readonly label?: string;
  readonly description: string;
  readonly available: boolean;
  readonly reason?: string;
}

interface ApiResponse {
  readonly status: number;
  readonly body: Json | CommandView[] | null;
}

export class ExpenseClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly actAs: string | undefined;

  constructor(baseUrl: string, token: string, actAs?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.actAs = actAs;
  }

  commands(): Promise<ApiResponse> {
    return this.request("GET", "/api/commands");
  }

  read(uri: string): Promise<ApiResponse> {
    return this.request("GET", `/api/read?uri=${encodeURIComponent(uri)}`);
  }

  events(since: number, glob?: string): Promise<ApiResponse> {
    const query = glob ? `&glob=${encodeURIComponent(glob)}` : "";
    return this.request("GET", `/api/events?since=${since}${query}`);
  }

  execute(uri: string, params: unknown): Promise<ApiResponse> {
    return this.request("POST", "/api/commands", { uri, params });
  }

  check(uri: string, params: unknown): Promise<ApiResponse> {
    return this.request("GET", `/api/check?uri=${encodeURIComponent(uri)}&params=${encodeURIComponent(JSON.stringify(params))}`);
  }

  history(kind: "undo" | "redo"): Promise<ApiResponse> {
    return this.request("POST", `/api/${kind}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (this.actAs) headers["x-act-as"] = this.actAs;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

const ID = { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "Report id, for example r-1" };
const reportOnly = { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false };

/** Tool input schemas. Adapter knowledge: the kernel's descriptors do not carry schemas in this sample yet. */
const SCHEMAS: Record<string, Json> = {
  "command:/report/create": {
    type: "object",
    properties: {
      id: ID,
      title: { type: "string" },
      amount: { type: "number", exclusiveMinimum: 0 },
      payee: { type: "string" },
      payeeEmail: { type: "string" },
      bankAccount: { type: "string" },
    },
    required: ["id", "title", "amount", "payee", "payeeEmail", "bankAccount"],
  },
  "command:/report/edit": {
    type: "object",
    properties: { id: ID, title: { type: "string" }, amount: { type: "number", exclusiveMinimum: 0 } },
    required: ["id"],
  },
  "command:/report/reject": {
    type: "object",
    properties: { id: ID, reason: { type: "string", minLength: 1 } },
    required: ["id", "reason"],
  },
  "command:/report/delete": reportOnly,
  "command:/report/submit": reportOnly,
  "command:/report/unsubmit": reportOnly,
  "command:/report/approve": reportOnly,
  "command:/report/unapprove": reportOnly,
  "command:/report/pay": reportOnly,
};

const BUILT_IN_TOOLS: Json[] = [
  {
    name: "read_state",
    description: "Read a state node, for example state:/reports/r-1. Sensitive values are masked or refused for this actor.",
    inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
  },
  {
    name: "events_since",
    description: "List events after a sequence number that this actor may see.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "integer", minimum: 0 }, glob: { type: "string" } },
      required: ["since"],
    },
  },
  { name: "undo", description: "Undo your own most recent action, if it can still be undone.", inputSchema: { type: "object", properties: {} } },
  { name: "redo", description: "Redo your own most recently undone action.", inputSchema: { type: "object", properties: {} } },
];

/** `command:/report/submit` becomes `report_submit`. Each name must map back to exactly one command. */
export function toolName(uri: string): string {
  return uri.replace(/^command:\//, "").replace(/[/-]/g, "_");
}

export interface Projection {
  readonly tools: Json[];
  readonly uriByName: ReadonlyMap<string, string>;
  readonly signature: string;
}

/** Projects the commands available to this actor onto tools. Throws if two commands share a tool name. */
export function project(commands: readonly CommandView[]): Projection {
  const uriByName = new Map<string, string>();
  const tools: Json[] = [...BUILT_IN_TOOLS];
  for (const command of commands) {
    if (!command.available) continue;
    const name = toolName(command.uri);
    const existing = uriByName.get(name);
    if (existing !== undefined) {
      throw new Error(`Tool name collision: ${existing} and ${command.uri} both project to ${name}`);
    }
    uriByName.set(name, command.uri);
    tools.push({
      name,
      description: `${command.description} (${command.uri})`,
      inputSchema: SCHEMAS[command.uri] ?? { type: "object" },
    });
  }
  return { tools, uriByName, signature: tools.map((t) => String(t.name)).sort().join(",") };
}

export function createMcpServer(client: ExpenseClient): Server {
  const server = new Server(
    { name: "expense-sample", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } }
  );

  let published = "";

  async function snapshot(): Promise<Projection> {
    const res = await client.commands();
    if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`Could not read commands (HTTP ${res.status})`);
    return project(res.body as CommandView[]);
  }

  async function notifyIfChanged(): Promise<void> {
    const current = await snapshot();
    if (current.signature !== published) {
      published = current.signature;
      await server.sendToolListChanged();
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const projection = await snapshot();
    published = projection.signature;
    return { tools: projection.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Json;
    const projection = await snapshot();

    let res: ApiResponse;
    if (name === "read_state") {
      res = await client.read(String(args.uri ?? ""));
    } else if (name === "events_since") {
      res = await client.events(Number(args.since ?? 0), typeof args.glob === "string" ? args.glob : undefined);
    } else if (name === "undo" || name === "redo") {
      res = await client.history(name);
    } else {
      const uri = projection.uriByName.get(name);
      if (uri === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: `No available tool named ${name}. It may not be available to this actor right now.` }],
        };
      }
      res = await client.execute(uri, args);
    }

    await notifyIfChanged();
    return {
      isError: res.status >= 400,
      content: [{ type: "text", text: JSON.stringify(res.body, null, 2) }],
    };
  });

  return server;
}

async function main(): Promise<void> {
  const baseUrl = process.env.EXPENSE_URL ?? "http://localhost:3000";
  const token = process.env.EXPENSE_TOKEN;
  if (!token) {
    console.error("EXPENSE_TOKEN is required");
    process.exit(1);
  }
  const server = createMcpServer(new ExpenseClient(baseUrl, token, process.env.EXPENSE_ACT_AS));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
