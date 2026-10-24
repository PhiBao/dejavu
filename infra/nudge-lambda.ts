/**
 * AWS Lambda handler for Dejavu's daily nudge cron.
 *
 * Runs the same stale-relationship reconnect logic as `scripts/run-nudges.ts`,
 * but serverless: triggered by an EventBridge (CloudWatch Events) schedule rule
 * (e.g. rate(1 day)). This is the "agents that act" piece — the agent
 * proactively creates follow-ups without being asked.
 *
 * Deploy:
 *   1. Bundle this handler with the repo's lib/ (it needs the projection
 *      store; point DEJAVU_DATA_PATH at shared storage, e.g. EFS, or accept
 *      that the projection is rebuilt from Walrus via restore).
 *   2. Create a Lambda with handler `nudge-lambda.handler`.
 *   3. Set env: MEMWAL_* (for Walrus writes), NODE_ENV=production.
 *   4. Add an EventBridge rule: `rate(1 day)` → this Lambda.
 *
 * The handler is idempotent: it won't create a second open "reconnect"
 * commitment for a person who already has one.
 */
import { addCommitment, audit, loadStore, stalePeople } from "../lib/store";

const STALE_DAYS = 30;

interface LambdaEvent {
  // EventBridge scheduled events carry these; we ignore them and just run.
  source?: string;
  "detail-type"?: string;
}

export async function handler(_event: LambdaEvent): Promise<{
  statusCode: number;
  body: string;
}> {
  try {
    const users = loadStore().users;
    let created = 0;
    for (const u of users) {
      const stale = stalePeople(u.id, STALE_DAYS);
      for (const row of stale) {
        addCommitment({
          userId: row.user_id,
          personId: row.person_id,
          description: `Reconnect with ${row.name}`,
          dueAt: new Date().toISOString(),
          sourceMemoryId: null,
        });
        audit(row.user_id, "nudge_created", { personId: row.person_id });
        created++;
      }
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ created }),
    };
  } catch (err) {
    console.error("[nudge-lambda] failed:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "nudge run failed" }),
    };
  }
}
