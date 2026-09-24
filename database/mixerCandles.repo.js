
const db = require("../database");

async function insertMixerCandle(candle) {
  const {
    mixer_id,
    interval,
    time,
    open,
    high,
    low,
    close
  } = candle;

  const query = `
    INSERT INTO mixer_candles
      (mixer_id, interval, time, open, high, low, close)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (mixer_id, interval, time)
    DO NOTHING;
  `;

  await db.query(query, [
    mixer_id,
    interval,
    time,
    open,
    high,
    low,
    close
  ]);
}

async function getMixerCandles(mixerId, interval = "15s", limit = 300) {
  const query = `
    SELECT time, open, high, low, close
    FROM mixer_candles
    WHERE mixer_id = $1
      AND interval = $2
    ORDER BY time DESC
    LIMIT $3;
  `;

  const rows = await db.query(query, [
    mixerId,
    interval,
    limit
  ]);

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.reverse();
}

module.exports = {
  insertMixerCandle,
  getMixerCandles,
};
