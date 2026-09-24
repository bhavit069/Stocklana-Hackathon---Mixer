
const EPSILON = 1e-9;

const RANK = { added: 0, removed: 1, increased: 2, decreased: 3, unchanged: 4 };

function diffAllocations(fromAllocs, toAllocs) {
    const F = new Map((fromAllocs || []).map(a => [a.token_address, Number(a.weight)]));
    const T = new Map((toAllocs || []).map(a => [a.token_address, Number(a.weight)]));

    const rows = [];
    for (const address of new Set([...F.keys(), ...T.keys()])) {
        const from = F.has(address) ? F.get(address) : null;
        const to = T.has(address) ? T.get(address) : null;

        let kind;
        if (from === null) kind = 'added';
        else if (to === null) kind = 'removed';
        else if (Math.abs(to - from) < EPSILON) kind = 'unchanged';
        else if (to > from) kind = 'increased';
        else kind = 'decreased';

        rows.push({ address, from, to, delta: (to || 0) - (from || 0), kind });
    }

    rows.sort((a, b) =>
        RANK[a.kind] - RANK[b.kind] || Math.abs(b.delta) - Math.abs(a.delta));

    return rows;
}

function summarise(rows) {
    const out = { added: 0, removed: 0, increased: 0, decreased: 0, unchanged: 0 };
    for (const r of rows) out[r.kind]++;
    out.changed = out.added + out.removed + out.increased + out.decreased;
    return out;
}

module.exports = { diffAllocations, summarise, EPSILON };
