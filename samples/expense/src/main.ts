import { createExpenseServer } from "./server.ts";
import { buildDemo, DEMO_TOKENS } from "./demo.ts";

const port = Number(process.env.PORT ?? 3000);
const demo = buildDemo();

createExpenseServer(demo).listen(port, () => {
  console.log(`Expense sample listening on http://localhost:${port}`);
  console.log("Demo tokens (in-memory, reset on restart):");
  for (const [token, user] of Object.entries(DEMO_TOKENS)) console.log(`  ${token}  ->  ${user}`);
});
