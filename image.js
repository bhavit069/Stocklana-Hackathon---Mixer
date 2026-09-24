const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const FileType = require("file-type");

const TOKENS_IMG_DIR = path.join(__dirname, "..", "public", "token");

downloadImage(
  "https://raw.githubusercontent.com/metaDAOproject/futarchy/refs/heads/develop/scripts/assets/UMBRA/UMBRA.png",
  "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta"
).then((e) => {
  console.log(e)
});

module.exports = { downloadImage };
