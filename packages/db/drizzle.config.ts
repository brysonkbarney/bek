import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (process.env.NODE_ENV === "production" && !databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for production database migrations.",
  );
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl ?? "postgres://bek:bek@localhost:54329/bek",
  },
});
