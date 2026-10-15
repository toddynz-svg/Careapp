"use strict";
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "care.json");

// Two parents. Names and passwords come from environment variables so
// nothing private lives in the repo.
const PARENTS = {
  a: { name: process.env.PARENT_A_NAME || "Parent A", pass: process.env.PARENT_A_PASSWORD || "" },
  b: { name: process.env.PARENT_B_NAME || "Parent B", pass: process.env.PARENT_B_PASSWORD || "" },
};
if (!PARENTS.a.pass || !PARENTS.b.pass) {
  console.error("Set PARENT_A_PASSWORD and PARENT_B_PASSWORD before starting.");
  process.exit(1);
}

// ---------- tiny JSON file store ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { extras: {}, requests: [], expenses: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) { /* first run */ }
function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- session store ----------
// Sessions are kept in a JSON file next to the data so a redeploy doesn't
// sign everyone out. With two users this stays tiny.
const SESS_FILE = path.join(DATA_DIR, "sessions.json");
class FileStore extends session.Store {
  constructor() {
    super();
    this.s = {};
    try { this.s = JSON.parse(fs.readFileSync(SESS_FILE, "utf8")); } catch (e) { /* first run */ }
    this.prune();
  }
  prune() {
    const now = Date.now();
    for (const id of Object.keys(this.s)) {
      const exp = this.s[id].cookie && this.s[id].cookie.expires;
      if (exp && new Date(exp).getTime() <= now) delete this.s[id];
    }
  }
  write() {
    const tmp = SESS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.s));
    fs.renameSync(tmp, SESS_FILE);
  }
  get(id, cb) {
    const v = this.s[id];
    const exp = v && v.cookie && v.cookie.expires;
    if (exp && new Date(exp).getTime() <= Date.now()) { delete this.s[id]; return cb(null, null); }
    cb(null, v || null);
  }
  set(id, sess, cb) { this.s[id] = JSON.parse(JSON.stringify(sess)); this.prune(); this.write(); cb && cb(null); }
  destroy(id, cb) { delete this.s[id]; this.write(); cb && cb(null); }
  touch(id, sess, cb) { if (this.s[id]) { this.s[id].cookie = sess.cookie; this.write(); } cb && cb(null); }
}

if (!process.env.SESSION_SECRET)
  console.warn("SESSION_SECRET is not set, so everyone will be signed out whenever the server restarts.");

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use(session({
  store: new FileStore(),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  name: "care.sid",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 1000 * 60 * 60 * 24 * 90 },
}));

const isDate = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k);
const isParent = (p) => p === "a" || p === "b";
function auth(req, res, next) {
  if (req.session && isParent(req.session.who)) return next();
  res.status(401).json({ error: "Not signed in" });
}

// Names only, so the sign-in screen can show who's who before anyone signs in.
app.get("/api/names", (req, res) => res.json({ a: PARENTS.a.name, b: PARENTS.b.name }));

app.post("/api/login", (req, res) => {
  const { who, password } = req.body || {};
  if (!isParent(who) || typeof password !== "string") return res.status(400).json({ error: "Bad request" });
  const want = Buffer.from(PARENTS[who].pass), got = Buffer.from(password);
  const ok = want.length === got.length && crypto.timingSafeEqual(want, got);
  if (!ok) return res.status(401).json({ error: "Wrong password" });
  req.session.who = who;
  res.json({ who });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get("/api/state", auth, (req, res) => {
  res.json({
    who: req.session.who,
    names: { a: PARENTS.a.name, b: PARENTS.b.name },
    extras: db.extras,
    requests: db.requests,
    expenses: db.expenses,
  });
});

app.post("/api/requests", auth, (req, res) => {
  const b = req.body || {};
  const changes = {};
  if (b.changes && typeof b.changes === "object")
    for (const k of Object.keys(b.changes)) if (isDate(k) && isParent(b.changes[k])) changes[k] = b.changes[k];
  if (!Object.keys(changes).length || Object.keys(changes).length > 120) return res.status(400).json({ error: "No valid days" });
  const r = {
    id: crypto.randomBytes(8).toString("hex"),
    type: ["swap", "off", "holiday", "change"].includes(b.type) ? b.type : "change",
    from: req.session.who,
    changes,
    status: "pending",
    note: typeof b.note === "string" ? b.note.trim().slice(0, 500) : "",
    reply: "",
    createdAt: new Date().toISOString(),
  };
  db.requests.push(r);
  save();
  res.json(r);
});

app.post("/api/requests/:id/status", auth, (req, res) => {
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });
  if (r.status !== "pending") return res.status(409).json({ error: "Already answered" });
  const { status, reply } = req.body || {};
  const mine = r.from === req.session.who;
  if (mine && status !== "withdrawn") return res.status(403).json({ error: "You can only withdraw your own request" });
  if (!mine && !["approved", "declined"].includes(status)) return res.status(400).json({ error: "Bad status" });
  r.status = status;
  r.respondedAt = new Date().toISOString();
  if (typeof reply === "string" && reply.trim()) r.reply = reply.trim().slice(0, 300);
  save();
  res.json(r);
});

// ---------- shared expenses ----------
// Amounts are whole cents. The payer pays the bill; the other parent owes
// their share and says where and when that money will be available.
const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const cents = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000000 ? v : null);
const dateOrEmpty = (v) => (typeof v === "string" && isDate(v) ? v : "");

function expenseFields(b, e) {
  const title = b.title !== undefined ? str(b.title, 80) : e.title;
  const total = b.total !== undefined ? cents(b.total) : e.total;
  const shares = b.shares !== undefined ? b.shares : e.shares;
  const payer = b.payer !== undefined ? b.payer : e.payer;
  if (!title) return { err: "Give the bill a name" };
  if (!total) return { err: "Enter the bill total" };
  if (!shares || cents(shares.a) === null || cents(shares.b) === null || shares.a + shares.b !== total)
    return { err: "The two shares must add up to the total" };
  if (!isParent(payer)) return { err: "Choose who pays the bill" };
  return {
    title, total, shares: { a: shares.a, b: shares.b }, payer,
    due: b.due !== undefined ? dateOrEmpty(b.due) : e.due,
    where: b.where !== undefined ? str(b.where, 200) : e.where,
    when: b.when !== undefined ? dateOrEmpty(b.when) : e.when,
    note: b.note !== undefined ? str(b.note, 500) : e.note,
  };
}

app.post("/api/expenses", auth, (req, res) => {
  const blank = { title: "", total: 0, shares: null, payer: "", due: "", where: "", when: "", note: "" };
  const v = expenseFields(req.body || {}, blank);
  if (v.err) return res.status(400).json({ error: v.err });
  const e = Object.assign({
    id: crypto.randomBytes(8).toString("hex"),
    from: req.session.who,
    billPaid: false, shareSent: false, shareReceived: false,
    createdAt: new Date().toISOString(),
  }, v);
  db.expenses.push(e);
  save();
  res.json(e);
});

app.post("/api/expenses/:id", auth, (req, res) => {
  const e = db.expenses.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Not found" });
  const me = req.session.who, b = req.body || {};
  const isPayer = e.payer === me;
  if (b.action === "delete") {
    if (e.from !== me) return res.status(403).json({ error: "Only the person who added it can delete it" });
    db.expenses = db.expenses.filter((x) => x !== e);
    save();
    return res.json({ ok: true });
  }
  if (b.action) {
    // Each step is ticked by the person who did it: the payer pays the bill
    // and confirms the money arrived; the other parent sends their share.
    const steps = { billPaid: true, shareSent: false, shareReceived: true };
    if (!(b.action in steps)) return res.status(400).json({ error: "Bad action" });
    if (steps[b.action] !== isPayer) return res.status(403).json({ error: "That step is for the other parent" });
    e[b.action] = b.value !== false;
    e[b.action + "At"] = e[b.action] ? new Date().toISOString() : "";
  } else {
    if (e.shareReceived) return res.status(409).json({ error: "This bill is settled" });
    const v = expenseFields(b, e);
    if (v.err) return res.status(400).json({ error: v.err });
    Object.assign(e, v);
  }
  e.updatedAt = new Date().toISOString();
  e.updatedBy = me;
  save();
  res.json(e);
});

app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log("Care calendar listening on " + PORT));
