import { createBekDbClient, seedBekSnapshot } from "../packages/db/src/index";

const client = createBekDbClient();

try {
  const snapshot = await seedBekSnapshot(client.db);
  console.log(
    `Seeded Bek snapshot for ${snapshot.org.id} (${snapshot.org.slug}) with ${snapshot.runs.length} run(s).`,
  );
} finally {
  await client.close();
}
