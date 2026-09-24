const { Pool } = require("pg");

const state = "production";

const pool = new Pool({
  host: "localhost",
  port: 26257,
  user: "root",
  database: "mixer",
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

async function query(text, params = [], options = {}) {
  const start = Date.now();

  try {
    const result = await pool.query(text, params);

    if (state !== "production") {
      console.log("🧠 DB QUERY", {
        text,
        params,
        rows: result.rowCount,
        duration: `${Date.now() - start}ms`
      });
    }

    return result.rows;
  } catch (err) {
    console.error("🔥 DB ERROR", {
      text,
      params,
      message: err.message
    });
    throw err;
  }
}

async function transaction(fn) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  console.log("🛑 Closing DB pool...");
  await pool.end();
}

module.exports = {
  pool,
  query,
  transaction,
  close
};
