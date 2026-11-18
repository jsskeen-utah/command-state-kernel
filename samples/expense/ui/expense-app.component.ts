import { Component, inject, InjectionToken, OnInit } from "@angular/core";
import type { ExpenseApi } from "./expense-api.ts";

export const EXPENSE_API = new InjectionToken<ExpenseApi>("ExpenseApi");

/**
 * The screen holds no business rules. Each button is enabled or disabled by the server's answer
 * for that report, and its tooltip is the server's reason.
 */
@Component({
  selector: "expense-app",
  template: `
    <h1>Expense reports</h1>
    <label>
      Signed in as
      <select (change)="switchUser($any($event.target).value)">
        @for (u of users; track u.token) {
          <option [value]="u.token" [selected]="u.token === api.user()">{{ u.name }}</option>
        }
      </select>
    </label>
    <p role="status">{{ api.message() }}</p>
    @for (r of api.reports(); track r.id) {
      <section>
        <h2>{{ r.title }}: {{ r.amount }} ({{ r.status }})</h2>
        @for (a of api.actionsFor(r.id); track a.uri) {
          <button type="button" [disabled]="!a.enabled" [title]="a.reason ?? ''" (click)="act(a.uri, r.id)">
            {{ a.label }}
          </button>
        }
      </section>
    }
  `,
})
export class ExpenseAppComponent implements OnInit {
  readonly api = inject(EXPENSE_API);

  readonly users = [
    { token: "tok-alice", name: "Alice (employee)" },
    { token: "tok-mia", name: "Mia (manager)" },
    { token: "tok-fin", name: "Fin (finance)" },
    { token: "tok-root", name: "Root (admin)" },
  ];

  ngOnInit(): void {
    if (!this.api.user()) void this.api.switchUser("tok-alice");
  }

  switchUser(token: string): void {
    void this.api.switchUser(token);
  }

  act(uri: string, reportId: string): void {
    void this.api.act(uri, reportId);
  }
}
