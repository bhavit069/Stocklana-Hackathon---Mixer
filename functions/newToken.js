
const axios = require("axios");
const { createToken, updateSecondaryInfo } = require("../database/token.repo");
const fs = require("fs")
const path = require("path");
const mime = require("mime-types");
const FileType = require("file-type");

require("dotenv").config();
const TOKENS_IMG_DIR = path.join(__dirname, "..", "public", "tokens");

async function addToken(address) {

  const jupUrl = `https://api.jup.ag/ultra/v1/search?query=${address}`;

  const jupResp = await axios.get(jupUrl, {
    headers: {
      "x-api-key": process.env.JUP_API_KEY
    },
    timeout: 10_000
  });

  const results = jupResp.data;

  if (!Array.isArray(results) || results.length === 0) {
    return false;
  }

  const token = results.find(r => r && r.id === address);
  if (!token) {
    return false;
  }

  const now = new Date().toISOString();

  console.log({
    address,
    name: token.name,
    symbol: token.symbol,
    logo: token.icon,
    decimals: token.decimals,
    is_verified: token.isVerified === true,
    created_at: token.createdAt ?? now
  })

  downloadImage(token.icon, address).catch(err => {
    console.log("[DOWNLOAD IMAGE ERROR]", err);
  })

  const createdToken = await createToken({
    address,
    name: token.name,
    symbol: token.symbol,
    logo: token.icon,
    decimals: token.decimals,
    is_verified: token.isVerified === true,
    created_at: token.createdAt ?? now
  });

  fireRugCheck(address).catch(err => {
    console.error("[RUGCHECK ERROR]", address, err.message);
  });

  return createdToken;
}

async function fireRugCheck(address) {
  const rugUrl = `https://api.rugcheck.xyz/v1/tokens/${address}/report`;

  const resp = await axios.get(rugUrl, { timeout: 10_000 });
  const report = resp.data;

  const score_normalised =
    typeof report.score_normalised === "number"
      ? report.score_normalised
      : null;

  const rugged =
    typeof report.rugged === "boolean"
      ? report.rugged
      : null;

  const freeze_authority =
    report.freezeAuthority === null ? false : true;

  const mint_authority =
    report.mintAuthority === null ? false : true;

  await updateSecondaryInfo(address, {
    score_normalised,
    rugged,
    freeze_authority,
    mint_authority
  });
}

if (!fs.existsSync(TOKENS_IMG_DIR)) {
  fs.mkdirSync(TOKENS_IMG_DIR, { recursive: true });
}

function imageCandidates(url) {
  const out = [url];

  const m = String(url).match(/\/ipfs\/([A-Za-z0-9]+)/);
  if (m) {
    const cid = m[1];
    for (const gw of [
      'https://cloudflare-ipfs.com/ipfs/',
      'https://gateway.pinata.cloud/ipfs/',
      'https://dweb.link/ipfs/',
    ]) {
      const candidate = gw + cid;
      if (!out.includes(candidate)) out.push(candidate);
    }
  }

  return out;
}

async function downloadImage(url, name) {

  const candidates = imageCandidates(url);
  let lastErr;

  for (const candidate of candidates) {
    try {
      return await fetchAndStore(candidate, name);
    } catch (err) {
      lastErr = err;
    }
  }

  console.error('Image download failed for', name + ':',
    lastErr ? lastErr.message : 'no candidates');
  return null;
}

async function fetchAndStore(url, name) {
  {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "max-age=0",
      "Upgrade-Insecure-Requests": "1"
      }
    });

    const buffer = Buffer.from(response.data);

    const detected = await FileType.fromBuffer(buffer);

    const headerType = mime.extension(response.headers["content-type"]);

    const ext = detected?.ext || headerType || "png";

    const fileName = `${name}.${ext}`;
    const filePath = path.join(TOKENS_IMG_DIR, fileName);

    if (!detected && !/^(png|jpe?g|gif|webp|svg|avif)$/i.test(String(headerType))) {
      throw new Error('not an image (' + (response.headers['content-type'] || 'unknown') + ')');
    }

    fs.writeFileSync(filePath, buffer);

    return fileName;
  }
}

module.exports = { addToken, downloadImage };