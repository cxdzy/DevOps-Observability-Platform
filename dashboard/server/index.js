// Entry point: reads the environment, waits for PostgreSQL, then serves the dashboard.
const path = require("path");
const { Pool } = require("pg");
const { query, INFLUX_URL } = require("./influx");
const { createDb } = require("./db");
const { createApp } = require("./app");
const { parseTrustProxy } = require("./security");

const PORT = process.env.PORT || 3000;
const HOUR_MS = 60 * 60 * 1000;
const RETRY_MS = 5000;

const config = {
  appOrigin: (process.env.APP_ORIGIN || "http://localhost:3100").replace(/\/+$/, ""),
  cookieSecure: !/^(false|0|no)$/i.test(process.env.COOKIE_SECURE || "true"),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  clientDist: path.resolve(process.env.CLIENT_DIST || "/app/client/dist"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set; the dashboard needs its PostgreSQL database");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  pool.on("error", (err) => console.error("postgres pool error:", err.message));
  const db = createDb(pool);

  // The database may start after this container, so keep trying.
  for (;;) {
    try {
      await db.init();
      break;
    } catch (err) {
      console.error(`database not ready (${err.message}); retrying in ${RETRY_MS / 1000} s`);
      await sleep(RETRY_MS);
    }
  }

  async function cleanup() {
    try {
      const removed = await db.deleteExpiredSessions(new Date());
      if (removed) console.log(`removed ${removed} expired sessions`);
    } catch (err) {
      console.error("expired session cleanup failed:", err.message);
    }
  }
  await cleanup();
  setInterval(cleanup, HOUR_MS).unref();

  const { app } = createApp({ db, query, influxUrl: INFLUX_URL, config });
  app.listen(PORT, () => {
    console.log(
      `dashboard listening on ${PORT} (origin ${config.appOrigin}, secure cookies ${config.cookieSecure}, ` +
        `trust proxy ${config.trustProxy}, google sign-in ${config.googleClientId ? "on" : "off"})`
    );
  });
}

main();
