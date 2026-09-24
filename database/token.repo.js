
const { query } = require('../database');

const createToken = async (tokenData) => {
    const {
      address,
      name,
      symbol,
      logo,
      decimals,
      is_verified,
      created_at
    } = tokenData;

    const queryStr = `
      INSERT INTO token_info (
        address,
        name,
        symbol,
        logo,
        decimals,
        is_verified,
        created_at,
        detected_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
      RETURNING *;
    `;

    const values = [
      address,
      name,
      symbol,
      logo,
      decimals,
      is_verified,
      created_at
    ];

    const rows = await query(queryStr, values);
    return rows[0];
  }

const updateSecondaryInfo = async (address, fields) => {
    const allowedFields = [
      "score_normalised",
      "freeze_authority",
      "mint_authority",
      "rugged"
    ];

    const keys = Object.keys(fields).filter(k => allowedFields.includes(k));
    if (keys.length === 0) {
      throw new Error("No valid secondary fields provided");
    }

    const setClauses = keys.map(
      (key, idx) => `${key} = $${idx + 2}`
    );

    const queryStr = `
      UPDATE token_info
      SET ${setClauses.join(", ")},
          updated_at = now()
      WHERE address = $1
      RETURNING *;
    `;

    const values = [address, ...keys.map(k => fields[k])];

    const rows = await query(queryStr, values);

    if (rows.length === 0) {
      throw new Error("Token not found");
    }

    return rows[0];
  }

const getTokenByAddress = async (address) => {
    const queryStr = `
      SELECT *
      FROM token_info
      WHERE address = $1;
    `;

    const rows = await query(queryStr, [address]);
    return rows[0] || null;
  }

const tokenExists = async (address) => {
    const queryStr = `
      SELECT 1
      FROM token_info
      WHERE address = $1
      LIMIT 1;
    `;

    const rows = await query(queryStr, [address]);
    return rows.length > 0;
  }

const getTokensByAddresses = async (addresses) => {
    if (!addresses.length) return [];

    const queryStr = `
      SELECT *
      FROM token_info
      WHERE address = ANY($1);
    `;

    const rows = await query(queryStr, [addresses]);
    return rows;
  }

const listTokensByStatus = async (filters = {}) => {
    const clauses = [];
    const values = [];
    let idx = 1;

    if (filters.is_verified !== undefined) {
      clauses.push(`is_verified = $${idx++}`);
      values.push(filters.is_verified);
    }

    if (filters.rugged !== undefined) {
      clauses.push(`rugged = $${idx++}`);
      values.push(filters.rugged);
    }

    if (filters.has_secondary_info === true) {
      clauses.push(`score_normalised IS NOT NULL`);
    }

    let queryStr = `SELECT * FROM token_info`;

    if (clauses.length) {
      queryStr += ` WHERE ${clauses.join(" AND ")}`;
    }

    queryStr += ` ORDER BY detected_at DESC`;

    if (filters.limit) {
      queryStr += ` LIMIT ${Number(filters.limit)}`;
    }

    if (filters.offset) {
      queryStr += ` OFFSET ${Number(filters.offset)}`;
    }

    const rows = await query(queryStr, values);
    return rows;
  }

module.exports = {
  createToken,
  updateSecondaryInfo,
  getTokenByAddress,
  tokenExists,
  getTokensByAddresses,
  listTokensByStatus
};