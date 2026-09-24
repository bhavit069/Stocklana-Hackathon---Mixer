
const { query } = require('../database');

async function allCompetitions() {

    const sql = `
        WITH RECURSIVE lineage AS (
            SELECT m.mixer_id, m.parent_mixer_id, m.name, m.ticker, m.image,
                   m.thesis_title, m.created_by, m.created_at,
                   m.mixer_id AS root_id, 0::INT AS depth,
                   ARRAY[m.mixer_id] AS visited
              FROM mixers m
             WHERE m.parent_mixer_id IS NULL
            UNION ALL
            SELECT c.mixer_id, c.parent_mixer_id, c.name, c.ticker, c.image,
                   c.thesis_title, c.created_by, c.created_at,
                   l.root_id, (l.depth + 1)::INT,
                   l.visited || c.mixer_id
              FROM mixers c
              JOIN lineage l ON c.parent_mixer_id = l.mixer_id
             WHERE NOT c.mixer_id = ANY(l.visited)
        )
        SELECT * FROM lineage ORDER BY root_id, depth ASC, created_at ASC;
    `;

    const rows = await query(sql);

    const byRoot = new Map();
    for (const r of rows) {
        const list = byRoot.get(r.root_id) || [];
        list.push({ ...r, depth: Number(r.depth) });
        byRoot.set(r.root_id, list);
    }

    for (const [root, list] of byRoot) {
        if (list.length < 2) byRoot.delete(root);
    }

    return byRoot;
}

module.exports = { allCompetitions };
