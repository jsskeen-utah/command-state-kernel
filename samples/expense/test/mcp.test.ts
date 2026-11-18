import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createExpenseServer } from "../src/server.ts";
import { buildDemo } from "../src/demo.ts";
import { project, toolName } from "../src/mcp.ts";

const MCP_PATH = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));

test("tool names map back to exactly one command", () => {
  assert.equal(toolName("command:/report/submit"), "report_submit");
  assert.equal(toolName("command:/report/unsubmit"), "report_unsubmit");
});

test("two commands that project to the same tool name are refused at startup", () => {
  assert.throws(
    () =>
      project([
        { uri: "command:/report/a-b", description: "", available: true },
        { uri: "command:/report/a/b", description: "", available: true },
      ]),
    /collision/
  );
});

test("an MCP client sees only its actor's available tools, and is told when they change", async () => {
  const demo = buildDemo();
  const rest = createExpenseServer(demo);
  await new Promise<void>((resolve) => rest.listen(0, resolve));
  const base = `http://localhost:${(rest.address() as AddressInfo).port}`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_PATH],
    env: { ...(process.env as Record<string, string>), EXPENSE_URL: base, EXPENSE_TOKEN: "tok-alice" },
    stderr: "inherit",
  });
  const client = new Client({ name: "expense-test", version: "0.0.0" }, { capabilities: {} });
  let notifications = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notifications += 1;
  });

  try {
    await client.connect(transport);
    const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();

    assert.deepEqual(await names(), [
      "events_since",
      "read_state",
      "redo",
      "report_create",
      "report_delete",
      "report_edit",
      "report_submit",
      "report_unsubmit",
      "undo",
    ]);

    const submitted = await client.callTool({ name: "report_submit", arguments: { id: "r-1" } });
    assert.equal(submitted.isError, false);

    const afterSubmit = await names();
    assert.ok(!afterSubmit.includes("report_submit"), "submit is gone once no draft remains");
    assert.ok(!afterSubmit.includes("report_delete"), "delete is gone once no draft remains");
    assert.ok(notifications >= 1, "the client was told the tool list changed");

    const read = await client.callTool({ name: "read_state", arguments: { uri: "state:/reports/r-1" } });
    assert.match(String((read.content as Array<{ text: string }>)[0].text), /"status": "submitted"/);

    const approve = await client.callTool({ name: "report_approve", arguments: { id: "r-1" } });
    assert.equal(approve.isError, true, "approval is not a tool for an employee");

    const undone = await client.callTool({ name: "undo", arguments: {} });
    assert.equal(undone.isError, false);
    assert.ok((await names()).includes("report_submit"), "submit is back after undo");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => rest.close(() => resolve()));
  }
});
