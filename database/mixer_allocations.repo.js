
const { query } = require('../database');

const addMixerAllocation = async ({
    mixer_id,
    token_address,
    vault_pda,
    weight,
    mirror_mint = null,

    inception_price = null
}) => {
    const sql = `
        INSERT INTO mixer_allocations (
            mixer_id,
            token_address,
            vault_pda,
            weight,
            mirror_mint,
            inception_price
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *;
    `;

    const rows = await query(sql, [
        mixer_id,
        token_address,
        vault_pda,
        weight,
        mirror_mint,
        inception_price
    ]);

    return rows[0];
};

const fetchMixerAllocationsByMixerId = async (mixer_id) => {

    const sql = `
        SELECT *
        FROM mixer_allocations
        WHERE mixer_id = $1
        ORDER BY weight DESC, token_address;
    `;

    return query(sql, [mixer_id]);
};

const fetchAllocationsForMixers = async (mixer_ids) => {
    if (!Array.isArray(mixer_ids) || !mixer_ids.length) return [];
    const sql = `
        SELECT *
        FROM mixer_allocations
        WHERE mixer_id = ANY($1)
        ORDER BY mixer_id, weight DESC, token_address;
    `;
    return query(sql, [mixer_ids]);
};

const fetchMixersUsingToken = async (token_address) => {

    const sql = `
        SELECT mixer_id, weight
        FROM mixer_allocations
        WHERE token_address = $1
        ORDER BY weight DESC;
    `;

    return query(sql, [token_address]);
};

const countMixersUsingToken = async (token_address) => {
    const sql = `
        SELECT COUNT(*)::INT AS count
        FROM mixer_allocations
        WHERE token_address = $1;
    `;

    const rows = await query(sql, [token_address]);

    return Number(rows[0]?.count ?? 0);
};

module.exports = {
    addMixerAllocation,
    fetchMixerAllocationsByMixerId,
    fetchAllocationsForMixers,
    fetchMixersUsingToken,
    countMixersUsingToken
};
