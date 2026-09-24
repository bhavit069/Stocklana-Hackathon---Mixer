
const MAX_LEN = 300;

function normaliseWebsite(raw) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    let s = String(raw).trim();
    if (!s) return { ok: true, value: null };
    if (s.length > MAX_LEN) {
        return { ok: false, error: `The link must be ${MAX_LEN} characters or fewer` };
    }

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;

    let url;
    try { url = new URL(s); } catch {
        return { ok: false, error: 'That link is not a valid web address' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, error: 'The link must be a web address (http or https)' };
    }

    if (!url.hostname || !url.hostname.includes('.')) {
        return { ok: false, error: 'That link is missing a domain' };
    }

    if (url.username || url.password) {
        return { ok: false, error: 'Links containing a username or password are not allowed' };
    }
    return { ok: true, value: url.toString() };
}

function websiteHost(value) {
    if (!value || !/^https?:\/\//i.test(String(value))) return null;
    try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return null; }
}

module.exports = { normaliseWebsite, websiteHost, MAX_LEN };
