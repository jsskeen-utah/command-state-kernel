import { signal } from "@angular/core";

/**
 * Browser-side client for the expense REST adapter. It mirrors the in-process KernelSignals adapter:
 * state and availability are signals, and the server stays the only source of truth.
 */

export interface ReportSummary {
  readonly id: string;
  readonly title: string;
  readonly amount: number;
  readonly ownerId: string;
  readonly status: string;
}

export interface RowAction {
  readonly uri: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
}

const ROW_ACTIONS: ReadonlyArray<{ uri: string; label: string }> = [
  { uri: "command:/report/submit", label: "Submit" },
  { uri: "command:/report/unsubmit", label: "Withdraw" },
  { uri: "command:/report/delete", label: "Delete" },
  { uri: "command:/report/approve", label: "Approve" },
  { uri: "command:/report/pay", label: "Pay" },
];

export class ExpenseApi {
  readonly reports = signal<ReportSummary[]>([]);
  readonly rowActions = signal<Record<string, RowAction[]>>({});
  readonly message = signal("");
  readonly user = signal("");

  private readonly baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  actionsFor(reportId: string): RowAction[] {
    return this.rowActions()[reportId] ?? [];
  }

  async switchUser(token: string): Promise<void> {
    this.token = token;
    this.user.set(token);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const list = await this.get(`/api/read?uri=${encodeURIComponent("state:/reports")}`);
    if (list.status !== 200) {
      this.message.set(`Could not load reports: ${list.body?.reason ?? list.status}`);
      return;
    }
    const reports = list.body.data as ReportSummary[];
    this.reports.set(reports);

    const actions: Record<string, RowAction[]> = {};
    for (const report of reports) {
      actions[report.id] = await Promise.all(
        ROW_ACTIONS.map(async (action) => {
          const params = encodeURIComponent(JSON.stringify({ id: report.id }));
          const check = await this.get(`/api/check?uri=${encodeURIComponent(action.uri)}&params=${params}`);
          return {
            uri: action.uri,
            label: action.label,
            enabled: check.body.available === true && check.body.valid === true,
            reason: check.body.reason,
          };
        })
      );
    }
    this.rowActions.set(actions);
  }

  async act(uri: string, reportId: string): Promise<void> {
    const res = await this.post("/api/commands", { uri, params: { id: reportId } });
    this.message.set(res.status === 200 ? `Done: ${res.body.summary}` : `Refused: ${res.body.reason}`);
    await this.refresh();
  }

  private get(path: string) {
    return this.request("GET", path);
  }

  private post(path: string, body: unknown) {
    return this.request("POST", path, body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
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
