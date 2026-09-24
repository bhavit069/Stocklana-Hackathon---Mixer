
const CATEGORIES = [
    {
        id: 'ai',
        label: 'AI',
        icon: '◈',
        description: 'Artificial intelligence and compute',
    },
    {
        id: 'defi',
        label: 'DeFi',
        icon: '◉',
        description: 'Lending, DEXs and yield',
    },
    {
        id: 'memes',
        label: 'Memes',
        icon: '◐',
        description: 'Community and culture coins',
    },
    {
        id: 'pre-ipo',
        label: 'Pre-IPO',
        icon: '△',
        description: 'Tokenized private companies',
    },
    {
        id: 'gaming',
        label: 'Gaming',
        icon: '▣',
        description: 'Games, metaverse and NFTs',
    },
    {
        id: 'infra',
        label: 'Infrastructure',
        icon: '▦',
        description: 'L1s, L2s and protocols',
    },
    {
        id: 'stables',
        label: 'Stables',
        icon: '○',
        description: 'Dollar-pegged and low volatility',
    },
    {
        id: 'other',
        label: 'Other',
        icon: '◌',
        description: 'Anything that does not fit above',
    },
];

const BY_ID = CATEGORIES.reduce((a, c) => { a[c.id] = c; return a; }, {});

function isCategory(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
}

function normalise(raw) {
    if (typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase();
    return isCategory(id) ? id : null;
}

function describe(id) {
    if (isCategory(id)) return BY_ID[id];
    return {
        id: null,
        label: 'Uncategorised',
        icon: '◌',
        description: 'No category set',
    };
}

module.exports = { CATEGORIES, isCategory, normalise, describe };
