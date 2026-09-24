
const MAX = 2000;
const icons = new Map();

function remember(mint, url) {
    if (!mint || !url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (icons.has(mint)) icons.delete(mint);
    icons.set(mint, url);
    if (icons.size > MAX) icons.delete(icons.keys().next().value);
}

function lookup(mint) {
    return icons.get(mint) || null;
}

module.exports = { remember, lookup };
