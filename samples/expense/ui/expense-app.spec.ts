import "@angular/compiler";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createExpenseServer } from "../src/server.ts";
import { buildDemo } from "../src/demo.ts";
import { ExpenseApi } from "./expense-api.ts";
import { EXPENSE_API, ExpenseAppComponent } from "./expense-app.component.ts";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

let server: Server;
let base: string;

beforeAll(async () => {
  const demo = buildDemo();
  server = createExpenseServer(demo);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function render(token: string) {
  const api = new ExpenseApi(base, token);
  TestBed.configureTestingModule({
    imports: [ExpenseAppComponent],
    providers: [{ provide: EXPENSE_API, useValue: api }],
  });
  const fixture = TestBed.createComponent(ExpenseAppComponent);
  await api.switchUser(token);
  fixture.detectChanges();
  return { api, fixture, root: fixture.nativeElement as HTMLElement };
}

function button(root: HTMLElement, reportTitle: string, label: string): HTMLButtonElement | undefined {
  const section = [...root.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent?.includes(reportTitle));
  return [...(section?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;
}

describe("expense screen", () => {
  it("enables only the actions the server says are possible, with the reason as the tooltip", async () => {
    const { root } = await render("tok-alice");

    const submit = button(root, "Hotel stay", "Submit");
    expect(submit?.disabled).toBe(false);

    const submitted = button(root, "Client dinner", "Submit");
    expect(submitted?.disabled).toBe(true);
    expect(submitted?.title).toBe("Report is submitted, not draft");

    const approve = button(root, "Client dinner", "Approve");
    expect(approve?.disabled).toBe(true);
    expect(approve?.title).toMatch(/Only managers can approve/);
  });

  it("shows a different screen for a different actor", async () => {
    const { root } = await render("tok-fin");

    expect(button(root, "Training", "Pay")?.disabled).toBe(false);
    expect(button(root, "Hotel stay", "Submit")?.disabled).toBe(true);
    expect(button(root, "Hotel stay", "Submit")?.title).toBe("Only the owner can do this");
  });

  it("refreshes the buttons after an action, and reports the server's answer", async () => {
    const { api, fixture, root } = await render("tok-alice");

    await api.act("command:/report/submit", "r-1");
    fixture.detectChanges();

    expect(api.message()).toBe("Done: Submit report: r-1");
    expect(button(root, "Hotel stay", "Submit")?.disabled).toBe(true);
    expect(button(root, "Hotel stay", "Withdraw")?.disabled).toBe(false);
  });
});
