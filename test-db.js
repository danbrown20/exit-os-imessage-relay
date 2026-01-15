const Database = require("better-sqlite3");
const db = new Database("/Users/adforge/Library/Messages/chat.db", {readonly: true});
console.log("SUCCESS", db.prepare("SELECT COUNT(1) FROM message").get());
