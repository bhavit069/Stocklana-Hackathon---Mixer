
const { query } = require('../database');

const createMixer = async ({
    mixer_id,
    created_by,
    name,
    ticker,
    image,
    description,
    category,
    thesis_title,
    thesis,
    parent_mixer_id,
    counter_thesis,
    parent_name,
    parent_ticker,
    parent_snapshot,
    composition_key,
    expires_at,
    duration_ms,
    website,
    initial_price,
    mixer_authority_pda
}) => {
    const sql = `
        INSERT INTO mixers (
            mixer_id,
            created_by,
            name,
            ticker,
            image,
            description,
            category,
            thesis_title,
            thesis,
            parent_mixer_id,
            counter_thesis,
            parent_name,
            parent_ticker,
            parent_snapshot,
            composition_key,
            expires_at,
            duration_ms,
            website,
            initial_price,
            mixer_authority_pda
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        RETURNING *;
    `;

    const blank = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

    const values = [
        mixer_id,
        created_by,
        name,
        ticker,
        image,
        description,

        category || null,
        blank(thesis_title),
        blank(thesis),
        parent_mixer_id || null,

        parent_mixer_id ? blank(counter_thesis) : null,
        parent_mixer_id ? (parent_name || null) : null,
        parent_mixer_id ? (parent_ticker || null) : null,
        parent_mixer_id && parent_snapshot ? JSON.stringify(parent_snapshot) : null,
        composition_key || null,
        expires_at || null,

        expires_at ? (duration_ms || null) : null,

        blank(website),
        initial_price,
        mixer_authority_pda
    ];

    const rows = await query(sql, values);
    return rows[0];
};

const fetchRemixesOf = async (parent_mixer_id) => {
    const sql = `
        SELECT * FROM mixers
        WHERE parent_mixer_id = $1
        ORDER BY created_at DESC;
    `;
    return query(sql, [parent_mixer_id]);
};

const fetchFamilyOf = async (root_mixer_id) => {
    const sql = `
        WITH RECURSIVE lineage AS (
            -- Both branches must agree on type, and an untyped 0 is inferred
            -- as something the recursive term's INT + INT cannot match.
            SELECT m.*, 0::INT AS depth, ARRAY[m.mixer_id] AS visited
              FROM mixers m
             WHERE m.mixer_id = $1
            UNION ALL
            SELECT m.*, (f.depth + 1)::INT, f.visited || m.mixer_id
              FROM mixers m
              JOIN lineage f ON m.parent_mixer_id = f.mixer_id
             WHERE NOT m.mixer_id = ANY(f.visited)
        )
        SELECT * FROM lineage ORDER BY depth ASC, created_at ASC;
    `;
    const rows = await query(sql, [root_mixer_id]);

    return rows.map(r => ({ ...r, depth: Number(r.depth) }));
};

const fetchRootOf = async (mixer_id) => {
    const sql = `
        WITH RECURSIVE ancestry AS (
            SELECT m.mixer_id, m.parent_mixer_id, 0::INT AS depth,
                   ARRAY[m.mixer_id] AS visited
              FROM mixers m
             WHERE m.mixer_id = $1
            UNION ALL
            SELECT p.mixer_id, p.parent_mixer_id, (a.depth + 1)::INT,
                   a.visited || p.mixer_id
              FROM mixers p
              JOIN ancestry a ON a.parent_mixer_id = p.mixer_id
             WHERE NOT p.mixer_id = ANY(a.visited)
        )
        SELECT mixer_id FROM ancestry ORDER BY depth DESC LIMIT 1;
    `;
    const rows = await query(sql, [mixer_id]);

    return rows[0]?.mixer_id || mixer_id;
};

const countRemixesOf = async (parent_mixer_id) => {
    const sql = `
        SELECT count(*)::INT AS count FROM mixers WHERE parent_mixer_id = $1;
    `;
    const rows = await query(sql, [parent_mixer_id]);

    return Number(rows[0]?.count ?? 0);
};

const findByCompositionKey = async (composition_key) => {
    if (!composition_key) return null;
    const sql = `
        SELECT * FROM mixers
        WHERE composition_key = $1
        ORDER BY created_at ASC
        LIMIT 1;
    `;
    const rows = await query(sql, [composition_key]);
    return rows[0] || null;
};

const fetchExpiredUnsettled = async (now = new Date()) => {
    const sql = `
        SELECT * FROM mixers
        WHERE expires_at IS NOT NULL
          AND expires_at <= $1
          AND settled_at IS NULL
          AND status <> 'closed'
        ORDER BY expires_at ASC;
    `;
    return query(sql, [now]);
};

const markSettled = async (mixer_id) => {
    const sql = `
        UPDATE mixers
        SET settled_at = now(), status = 'closed', updated_at = now()
        WHERE mixer_id = $1 AND settled_at IS NULL
        RETURNING *;
    `;
    const rows = await query(sql, [mixer_id]);
    return rows[0] || null;
};

const fetchMemeMixers = async ({ includeSettled = true } = {}) => {
    const sql = includeSettled
        ? `SELECT * FROM mixers WHERE expires_at IS NOT NULL ORDER BY
             (settled_at IS NOT NULL), expires_at ASC;`
        : `SELECT * FROM mixers WHERE expires_at IS NOT NULL AND settled_at IS NULL
           ORDER BY expires_at ASC;`;
    return query(sql);
};

const fetchMixersByIds = async (mixer_ids) => {
    if (!Array.isArray(mixer_ids) || !mixer_ids.length) return [];
    const sql = `SELECT * FROM mixers WHERE mixer_id = ANY($1);`;
    return query(sql, [mixer_ids]);
};

const updateMixerStatus = async (mixer_id, status) => {
    const sql = `
        UPDATE mixers
        SET status = $2,
            updated_at = now()
        WHERE mixer_id = $1
        RETURNING *;
    `;

    const rows = await query(sql, [mixer_id, status]);
    return rows[0] || null;
};

const fetchMixerById = async (mixer_id) => {
    const sql = `
        SELECT *
        FROM mixers
        WHERE mixer_id = $1;
    `;

    const rows = await query(sql, [mixer_id]);
    return rows[0] || null;
};

const fetchMixersByCreator = async (created_by) => {
    const sql = `
        SELECT *
        FROM mixers
        WHERE created_by = $1
        ORDER BY created_at DESC;
    `;

    return query(sql, [created_by]);
};

const fetchMixersByStatus = async (status) => {
    const sql = `
        SELECT *
        FROM mixers
        WHERE status = $1
        ORDER BY created_at DESC;
    `;

    return query(sql, [status]);
};

const fetchAllMixers = async () => {
    const sql = `
        SELECT *
        FROM mixers
        ORDER BY created_at DESC;
    `;

    return query(sql);
};

module.exports = {
    createMixer,
    updateMixerStatus,
    fetchMixerById,
    fetchMixersByCreator,
    fetchMixersByStatus,
    fetchAllMixers,
    fetchRemixesOf,
    fetchFamilyOf,
    fetchRootOf,
    countRemixesOf,
    fetchMixersByIds,
    findByCompositionKey,
    fetchExpiredUnsettled,
    markSettled,
    fetchMemeMixers
};
