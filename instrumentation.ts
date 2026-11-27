// Runs once when the Next.js server starts, before it handles any request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("./db");
    const db = getDb();
    const version = db.pragma("user_version", { simple: true });
    console.log(`[db] ready (schema version ${version})`);
  }
}
