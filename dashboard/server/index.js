// Entry point: reads the environment, waits for PostgreSQL, then serves the dashboard.
const path = require("path");
const { Pool } = require("pg");
const { query, INFLUX_URL } = require("./influx");
const { createDb, isValidDatabaseUrl } = require("./db");
const { createApp } = require("./app");
const { parseHostList, createTrustedProxies } = require("./security");
const { DEFAULT_MAX_AGE_MS } = require("./sessions");

const PORT = process.env.PORT || 3000;
const HOUR_MS = 60 * 60 * 1000;
const RETRY_MS = 5000;
const PROXY_REFRESH_MS = 60 * 1000;
const BAD_URL_MESSAGE = "DATABASE_URL is not a valid URL, check DASHBOARD_DB_PASSWORD";

function maxAgeMs(value) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? hours * HOUR_MS : DEFAULT_MAX_AGE_MS;
}

const proxyHosts = parseHostList(process.env.TRUSTED_PROXY_HOSTS);
const config = {
  appOrigin: (process.env.APP_ORIGIN || "http://localhost:3100").replace(/\/+$/, ""),
  cookieSecure: !/^(false|0|no)$/i.test(process.env.COOKIE_SECURE || "true"),
  sessionMaxAgeMs: maxAgeMs(process.env.SESSION_MAX_AGE_HOURS),
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  clientDist: path.resolve(process.env.CLIENT_DIST || "/app/client/dist"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The connection string holds the password, so it is never printed, only this message.
function exitBadUrl() {
  console.error(BAD_URL_MESSAGE);
  process.exit(1);
}

async function connect() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set; the dashboard needs its PostgreSQL database");
    process.exit(1);
  }
  if (!isValidDatabaseUrl(process.env.DATABASE_URL)) exitBadUrl();

  // pg parses the URL again when it first connects and throws outside any promise, so a parse
  // error during start-up is turned into the same message instead of a crash with a stack trace.
  const onParseError = (err) => {
    if (err && (err.code === "ERR_INVALID_URL" || err instanceof URIError)) exitBadUrl();
    throw err;
  };
  process.on("uncaughtException", onParseError);
  let pool;
  try {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  } catch {
    exitBadUrl();
  }
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
  process.removeListener("uncaughtException", onParseError);
  return db;
}

async function main() {
  const db = await connect();

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

  // CF-Connecting-IP is believed only from these hosts (cloudflared), re-resolved every minute.
  const trusted = createTrustedProxies(proxyHosts);
  let lastCount = -1;
  const refreshProxies = async () => {
    const count = await trusted.refresh();
    if (count !== lastCount && proxyHosts.length) {
      console.log(`trusted proxy addresses for ${proxyHosts.join(", ")}: ${count}${count === 0 ? " (none resolved; trusting nobody)" : ""}`);
    }
    lastCount = count;
  };
  await refreshProxies();
  setInterval(refreshProxies, PROXY_REFRESH_MS).unref();

  const { app } = createApp({ db, query, influxUrl: INFLUX_URL, config, trusted });
  app.listen(PORT, () => {
    console.log(
      `dashboard listening on ${PORT} (origin ${config.appOrigin}, secure cookies ${config.cookieSecure}, ` +
        `trusted proxies ${proxyHosts.join(",") || "none"}, session limit ${config.sessionMaxAgeMs / HOUR_MS} h, ` +
        `google sign-in ${config.googleClientId ? "on" : "off"})`
    );
  });
}

main();
