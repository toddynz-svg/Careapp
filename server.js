"use strict";
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");
const R = require("./public/roster.js");

const PORT = process.env.PORT || 3000;
// On Railway, an attached volume sets RAILWAY_VOLUME_MOUNT_PATH; use it so
// data survives redeploys even if DATA_DIR wasn't set.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
// Running on Railway with no volume: everything saved is lost on the next deploy.
const NO_VOLUME = !!process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (NO_VOLUME) console.error("WARNING: no Railway volume attached. Data in " + DATA_DIR + " will be lost on the next deploy.");
else console.log("Saving data in " + DATA_DIR);
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
let db = { extras: {}, requests: [], expenses: [], activities: [], routine: null, special: {}, care: {}, push: { a: [], b: [] }, feeds: {}, notes: {}, kidInfo: {}, runs: {} };
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
// Receipt photos arrive as base64 JSON, so that one route takes bigger bodies.
const smallJson = express.json({ limit: "32kb" }), bigJson = express.json({ limit: "6mb" });
app.use((req, res, next) => (/^\/api\/expenses\/[^/]+\/receipt$/.test(req.path) ? bigJson : smallJson)(req, res, next));
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

// ---------- phone notifications (web push) ----------
// Keys are made on first start and kept with the data, so existing
// subscriptions keep working across redeploys.
const VAPID_FILE = path.join(DATA_DIR, "vapid.json");
let vapid;
try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); } catch (e) {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid));
}
webpush.setVapidDetails("mailto:care-calendar@example.invalid", vapid.publicKey, vapid.privateKey);
const money = (c) => "$" + (c / 100).toFixed(2);
const fmtDay = (k) => new Date(k + "T00:00:00Z").toLocaleDateString("en-NZ", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

// Tell the other parent about something one parent did. Never blocks the reply.
function tell(fromWho, body, tag) {
  const to = fromWho === "a" ? "b" : "a";
  const subs = (db.push && db.push[to]) || [];
  if (!subs.length) return;
  const payload = JSON.stringify({ title: PARENTS[fromWho].name, body, tag: tag || "care" });
  subs.forEach((sub) => {
    webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24 }).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.push[to] = db.push[to].filter((x) => x.endpoint !== sub.endpoint);
        save();
      } else console.error("push failed", err.statusCode || err.message);
    });
  });
}

app.get("/api/push/key", (req, res) => res.json({ key: vapid.publicKey }));
app.post("/api/push/subscribe", auth, (req, res) => {
  const sub = (req.body || {}).sub;
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return res.status(400).json({ error: "Bad subscription" });
  const who = req.session.who;
  db.push = db.push || { a: [], b: [] };
  for (const p of ["a", "b"]) db.push[p] = (db.push[p] || []).filter((x) => x.endpoint !== sub.endpoint);
  db.push[who].push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
  db.push[who] = db.push[who].slice(-10);
  save();
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", auth, (req, res) => {
  const ep = (req.body || {}).endpoint;
  db.push = db.push || { a: [], b: [] };
  for (const p of ["a", "b"]) db.push[p] = (db.push[p] || []).filter((x) => x.endpoint !== ep);
  save();
  res.json({ ok: true });
});

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
    activities: db.activities,
    special: db.special,
    care: db.care,
    notes: db.notes,
    kidInfo: db.kidInfo,
    runs: db.runs,
    noVolume: NO_VOLUME,
    routine: db.routine || defaultRoutine(),
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
  const days = Object.keys(changes).sort();
  tell(r.from, "New request: " + ({ swap: "swap weekends", off: "weekend off", holiday: "holiday", change: "change care days" })[r.type] +
    ", " + fmtDay(days[0]) + (days.length > 1 ? " to " + fmtDay(days[days.length - 1]) : ""), "req");
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
  if (!mine) tell(req.session.who, (status === "approved" ? "Agreed to" : "Declined") + " your request" + (r.reply ? ": " + r.reply : ""), "req");
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
    category: b.category !== undefined ? (CATEGORIES.includes(b.category) ? b.category : "Other") : e.category || "Other",
    kids: b.kids !== undefined ? (Array.isArray(b.kids) ? b.kids.filter((k) => (db.routine || defaultRoutine()).kids.includes(k)) : []) : e.kids || [],
  };
}
const CATEGORIES = ["School", "Health", "Activities", "Clothing", "Childcare", "Other"];

app.post("/api/expenses", auth, (req, res) => {
  const blank = { title: "", total: 0, shares: null, payer: "", due: "", where: "", when: "", note: "", category: "Other", kids: [] };
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
  tell(e.from, "New bill: " + e.title + ", " + money(e.total) + (e.due ? ", due " + fmtDay(e.due) : ""), "exp");
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
    (e.receipts || []).forEach((r) => fs.rm(path.join(RECEIPTS, r.file), () => {}));
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
  const owedBy = e.payer === "a" ? "b" : "a";
  const what = b.action === "billPaid" ? (e.billPaid ? "Paid the bill" : "Unmarked the bill as paid")
    : b.action === "shareSent" ? (e.shareSent ? "Sent " + money(e.shares[owedBy]) : "Unmarked their share as sent")
    : b.action === "shareReceived" ? (e.shareReceived ? "Got your " + money(e.shares[owedBy]) : "Unmarked your share as received")
    : "Updated the bill";
  tell(me, what + ": " + e.title, "exp");
  res.json(e);
});

// Receipt photos, saved next to the data. The page shrinks them before upload.
const RECEIPTS = path.join(DATA_DIR, "receipts");
fs.mkdirSync(RECEIPTS, { recursive: true });
app.post("/api/expenses/:id/receipt", auth, (req, res) => {
  const e = db.expenses.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Not found" });
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec((req.body || {}).image || "");
  if (!m) return res.status(400).json({ error: "That isn't a photo" });
  if ((e.receipts || []).length >= 10) return res.status(400).json({ error: "That's the most receipts for one bill" });
  const file = e.id + "-" + crypto.randomBytes(6).toString("hex") + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  fs.writeFileSync(path.join(RECEIPTS, file), Buffer.from(m[2], "base64"));
  (e.receipts = e.receipts || []).push({ file, by: req.session.who, at: new Date().toISOString() });
  save();
  tell(req.session.who, "Added a receipt: " + e.title, "exp");
  res.json(e);
});
app.post("/api/expenses/:id/receipt/:file/delete", auth, (req, res) => {
  const e = db.expenses.find((x) => x.id === req.params.id);
  const r = e && (e.receipts || []).find((x) => x.file === req.params.file);
  if (!r) return res.status(404).json({ error: "Not found" });
  if (r.by !== req.session.who) return res.status(403).json({ error: "Only the person who added it can remove it" });
  e.receipts = e.receipts.filter((x) => x !== r);
  fs.rm(path.join(RECEIPTS, r.file), () => {});
  save();
  res.json(e);
});
app.get("/api/receipts/:file", auth, (req, res) => {
  if (!/^[a-f0-9]+-[a-f0-9]+\.(jpg|png|webp)$/.test(req.params.file)) return res.status(404).end();
  res.sendFile(path.join(RECEIPTS, req.params.file), { maxAge: "30d" }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ---------- kids: weekly routine and activities ----------
// "has" means whoever has the children that day on the calendar.
const isWho = (v) => v === "a" || v === "b" || v === "has";
const isTime = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
function defaultRoutine() {
  const school = {};
  for (let d = 1; d <= 5; d++) school[d] = { drop: "has", pick: "has" };
  const nights = {};
  for (let d = 0; d <= 6; d++) nights[d] = "";
  return {
    kids: (process.env.KIDS || "").split(",").map((k) => k.trim()).filter(Boolean),
    dropTime: "08:30", pickTime: "15:00", school, nights,
  };
}

app.post("/api/routine", auth, (req, res) => {
  const b = req.body || {}, r = defaultRoutine();
  if (Array.isArray(b.kids)) r.kids = [...new Set(b.kids.map((k) => str(k, 30)).filter(Boolean))].slice(0, 8);
  if (isTime(b.dropTime)) r.dropTime = b.dropTime;
  if (isTime(b.pickTime)) r.pickTime = b.pickTime;
  for (let d = 1; d <= 5; d++) {
    const x = (b.school && b.school[d]) || {};
    r.school[d] = { drop: isWho(x.drop) || x.drop === "" ? x.drop : "has", pick: isWho(x.pick) || x.pick === "" ? x.pick : "has" };
  }
  for (let d = 0; d <= 6; d++) r.nights[d] = isParent(b.nights && b.nights[d]) ? b.nights[d] : "";
  r.updatedAt = new Date().toISOString();
  r.updatedBy = req.session.who;
  db.routine = r;
  save();
  tell(req.session.who, "Changed the weekly routine (school runs and sleeping)", "kids");
  res.json(r);
});

function activityFields(b, kids) {
  const title = str(b.title, 60);
  if (!title) return { err: "Give the activity a name" };
  const who = Array.isArray(b.kids) ? b.kids.filter((k) => kids.includes(k)) : [];
  if (!who.length) return { err: "Choose who it's for" };
  if (!isTime(b.start)) return { err: "Choose a start time" };
  if (b.end && (!isTime(b.end) || b.end <= b.start)) return { err: "The end time is before the start time" };
  const repeat = b.repeat === "once" ? "once" : "weekly";
  const a = { title, kids: who, repeat, start: b.start, end: b.end || "",
    location: str(b.location, 120), note: str(b.note, 300),
    drop: isWho(b.drop) ? b.drop : "", pick: isWho(b.pick) ? b.pick : "" };
  if (repeat === "once") {
    if (!isDate(b.date)) return { err: "Choose the date" };
    a.date = b.date;
  } else {
    a.days = Array.isArray(b.days) ? [...new Set(b.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    if (!a.days.length) return { err: "Choose at least one day" };
    a.from = dateOrEmpty(b.from);
    a.until = dateOrEmpty(b.until);
    if (a.from && a.until && a.until < a.from) return { err: "The end date is before the start date" };
  }
  return a;
}

app.post("/api/activities", auth, (req, res) => {
  const v = activityFields(req.body || {}, (db.routine || defaultRoutine()).kids);
  if (v.err) return res.status(400).json({ error: v.err });
  const a = Object.assign({ id: crypto.randomBytes(8).toString("hex"), by: req.session.who, createdAt: new Date().toISOString() }, v);
  db.activities.push(a);
  save();
  tell(req.session.who, "Added " + a.kids.join(", ") + ": " + a.title, "kids");
  res.json(a);
});

app.post("/api/activities/:id", auth, (req, res) => {
  const i = db.activities.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  if (b.action === "delete") {
    const gone = db.activities.splice(i, 1)[0];
    save();
    tell(req.session.who, "Removed " + gone.title, "kids");
    return res.json({ ok: true });
  }
  const v = activityFields(b, (db.routine || defaultRoutine()).kids);
  if (v.err) return res.status(400).json({ error: v.err });
  const old = db.activities[i];
  db.activities[i] = Object.assign({ id: old.id, by: old.by, createdAt: old.createdAt,
    updatedAt: new Date().toISOString(), updatedBy: req.session.who }, v);
  save();
  tell(req.session.who, "Changed " + v.kids.join(", ") + ": " + v.title, "kids");
  res.json(db.activities[i]);
});

// One-off change to who does a school run or activity drop-off/pickup on one day.
// slot is "school-drop", "school-pick", or an activity id plus "-drop" or "-pick".
app.post("/api/runs", auth, (req, res) => {
  const b = req.body || {};
  if (!isDate(b.date)) return res.status(400).json({ error: "Choose a date" });
  const m = /^(school|[0-9a-f]{16})-(drop|pick)$/.exec(String(b.slot || ""));
  const act = m && m[1] !== "school" ? db.activities.find((x) => x.id === m[1]) : null;
  if (!m || (m[1] !== "school" && !act)) return res.status(400).json({ error: "Unknown run" });
  const day = db.runs[b.date] || {};
  if (b.who === "") delete day[b.slot];
  else if (isParent(b.who)) day[b.slot] = b.who;
  else return res.status(400).json({ error: "Bad parent" });
  if (Object.keys(day).length) db.runs[b.date] = day; else delete db.runs[b.date];
  save();
  if (b.who) {
    const what = (act ? act.title : "school") + " " + (m[2] === "drop" ? "drop-off" : "pickup");
    tell(req.session.who, PARENTS[b.who].name + " is doing " + what + " on " + fmtDay(b.date), "cal");
  }
  res.json({ ok: true });
});

// ---------- special days ----------
// Extra dates such as teacher-only days.
app.post("/api/special", auth, (req, res) => {
  const b = req.body || {};
  if (!isDate(b.date)) return res.status(400).json({ error: "Choose a date" });
  const label = str(b.label, 60);
  if (!label) return res.status(400).json({ error: "Give the day a name" });
  const kids = (db.routine || defaultRoutine()).kids;
  db.special[b.date] = { label, noSchool: b.noSchool !== false,
    kids: Array.isArray(b.kids) ? b.kids.filter((k) => kids.includes(k)) : [],
    by: req.session.who, at: new Date().toISOString() };
  save();
  tell(req.session.who, "Added a special day: " + label + ", " + fmtDay(b.date), "cal");
  res.json(db.special[b.date]);
});
// Who has care on a holiday or special day, set directly by either parent.
// The calendar applies these and agreed requests in time order.
app.post("/api/care", auth, (req, res) => {
  const b = req.body || {};
  if (!isDate(b.date)) return res.status(400).json({ error: "Choose a date" });
  if (b.who === "") delete db.care[b.date];
  else if (isParent(b.who)) db.care[b.date] = { who: b.who, by: req.session.who, at: new Date().toISOString() };
  else return res.status(400).json({ error: "Bad parent" });
  save();
  if (b.who) tell(req.session.who, PARENTS[b.who].name + " has care on " + fmtDay(b.date), "cal");
  res.json({ ok: true });
});

app.post("/api/special/:date/delete", auth, (req, res) => {
  if (!db.special[req.params.date]) return res.status(404).json({ error: "Not found" });
  delete db.special[req.params.date];
  save();
  res.json({ ok: true });
});

// ---------- kids' info ----------
// Doctors, allergies, sizes, teachers and the like, one record per child.
const KID_FIELDS = ["birthday", "school", "teacher", "schoolPhone", "doctor", "doctorPhone", "dentist", "dentistPhone",
  "allergies", "medication", "clothes", "shoes", "other"];
app.post("/api/kidinfo", auth, (req, res) => {
  const b = req.body || {}, kids = (db.routine || defaultRoutine()).kids;
  if (!kids.includes(b.name)) return res.status(400).json({ error: "Unknown child" });
  const info = {};
  for (const f of KID_FIELDS) { const v = str((b.info || {})[f], f === "other" ? 1000 : 200); if (v) info[f] = v; }
  if (info.birthday && !isDate(info.birthday)) delete info.birthday;
  info.updatedBy = req.session.who;
  info.updatedAt = new Date().toISOString();
  db.kidInfo = db.kidInfo || {};
  db.kidInfo[b.name] = info;
  save();
  tell(req.session.who, "Updated " + b.name + "'s info", "kids");
  res.json(info);
});

// ---------- handover notes ----------
// Short notes for a day, usually a changeover: "Kendall's inhaler is in her bag".
app.post("/api/notes", auth, (req, res) => {
  const b = req.body || {}, text = str(b.text, 400);
  if (!isDate(b.date)) return res.status(400).json({ error: "Choose a date" });
  if (!text) return res.status(400).json({ error: "Write a note" });
  db.notes = db.notes || {};
  const n = { id: crypto.randomBytes(6).toString("hex"), by: req.session.who, text, at: new Date().toISOString() };
  (db.notes[b.date] = db.notes[b.date] || []).push(n);
  save();
  tell(req.session.who, "Handover note for " + fmtDay(b.date) + ": " + text, "cal");
  res.json(n);
});
app.post("/api/notes/:date/:id/delete", auth, (req, res) => {
  const list = (db.notes || {})[req.params.date] || [];
  const n = list.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: "Not found" });
  if (n.by !== req.session.who) return res.status(403).json({ error: "You can only remove your own notes" });
  db.notes[req.params.date] = list.filter((x) => x !== n);
  if (!db.notes[req.params.date].length) delete db.notes[req.params.date];
  save();
  res.json({ ok: true });
});

// ---------- calendar feed ----------
// Each parent gets a private link their phone's calendar can subscribe to.
// Anyone with the link can read it, so it can be reset to a new one.
function feedToken(who, reset) {
  db.feeds = db.feeds || {};
  if (reset || !db.feeds[who]) { db.feeds[who] = crypto.randomBytes(18).toString("base64url"); save(); }
  return db.feeds[who];
}
app.get("/api/feed", auth, (req, res) => res.json({ token: feedToken(req.session.who) }));
app.post("/api/feed/reset", auth, (req, res) => res.json({ token: feedToken(req.session.who, true) }));

const TZ = "Pacific/Auckland";
const nzToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const icsText = (t) => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line) {
  const out = [];
  let buf = Buffer.from(line, "utf8");
  while (buf.length > 74) {
    let n = 74;
    while (n > 0 && (buf[n] & 0xc0) === 0x80) n--; // don't split a UTF-8 character
    out.push(buf.slice(0, n).toString("utf8"));
    buf = buf.slice(n);
  }
  out.push(buf.toString("utf8"));
  return out.join("\r\n ");
}
const icsDate = (k) => k.replace(/-/g, "");
const icsTime = (k, t) => icsDate(k) + "T" + t.replace(":", "") + "00";
function addMinutes(t, m) { const x = +t.slice(0, 2) * 60 + +t.slice(3) + m; return String(Math.floor(x / 60) % 24).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); }

app.get("/cal/:token.ics", (req, res) => {
  const me = ["a", "b"].find((p) => db.feeds && db.feeds[p] && db.feeds[p] === req.params.token);
  if (!me) return res.status(404).send("Not found");
  const S = { extras: db.extras, reqs: db.requests, care: db.care, routine: db.routine || defaultRoutine(), special: db.special, acts: db.activities, runs: db.runs };
  R.recompute(S);
  const nm = (p) => PARENTS[p].name;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Care calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Care calendar (" + icsText(nm(me)) + ")", "X-WR-TIMEZONE:" + TZ, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    "BEGIN:VTIMEZONE", "TZID:" + TZ,
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+1200", "TZOFFSETTO:+1300", "TZNAME:NZDT", "DTSTART:19700927T020000", "RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+1300", "TZOFFSETTO:+1200", "TZNAME:NZST", "DTSTART:19700405T030000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU", "END:STANDARD",
    "END:VTIMEZONE"];
  const ev = (uid, props) => { L.push("BEGIN:VEVENT", "UID:" + uid + "@care-calendar", "DTSTAMP:" + stamp); props.forEach((p) => L.push(p)); L.push("END:VEVENT"); };
  const start = R.num(nzToday()) - 31, end = start + 31 + 366;
  // Care days, as one all-day event per run of days with the same parent.
  let run = null;
  const flush = () => { if (run) ev("care-" + run.from, ["DTSTART;VALUE=DATE:" + icsDate(run.from), "DTEND;VALUE=DATE:" + icsDate(R.key(run.to + 1)), "SUMMARY:" + icsText("Kids with " + nm(run.p)), "TRANSP:TRANSPARENT"]); run = null; };
  for (let n = start; n <= end; n++) {
    const k = R.key(n), o = R.owner(S, k);
    if (run && o === run.p && n === run.to + 1) run.to = n;
    else { flush(); if (o) run = { p: o, from: k, to: n }; }
    const label = R.dayName(S, k);
    if (label && !R.HOL[k]) ev("special-" + k, ["DTSTART;VALUE=DATE:" + icsDate(k), "DTEND;VALUE=DATE:" + icsDate(R.key(n + 1)), "SUMMARY:" + icsText(label), "TRANSP:TRANSPARENT"]);
    R.dayItems(S, k).forEach((it, i) => {
      if (!it.t) return;
      const mine = it.by.filter((x) => x[1] === me).map((x) => (x[0] || it.title).toLowerCase());
      // School runs only appear for the parent doing them; activities appear for both.
      if (it.kind === "school" && !mine.length) return;
      const title = it.kind === "school" ? it.title : it.title + (mine.length ? " (you: " + mine.join(", ") + ")" : "");
      const desc = it.by.map((x) => (x[0] || "By") + ": " + (x[1] ? nm(x[1]) : "not set")).concat(it.note ? [it.note] : []).join("\n");
      const props = ["DTSTART;TZID=" + TZ + ":" + icsTime(k, it.t), "DTEND;TZID=" + TZ + ":" + icsTime(k, it.end || addMinutes(it.t, it.kind === "school" ? 15 : 60)),
        "SUMMARY:" + icsText(title)];
      if (desc) props.push("DESCRIPTION:" + icsText(desc));
      if (it.location) props.push("LOCATION:" + icsText(it.location));
      ev(it.kind + "-" + k + "-" + i + "-" + crypto.createHash("sha1").update(it.title).digest("hex").slice(0, 8), props);
    });
  }
  flush();
  L.push("END:VCALENDAR");
  res.set({ "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" });
  res.send(L.map(fold).join("\r\n") + "\r\n");
});

// Phones should always check for a newer page and scripts, so updates show
// up without clearing the browser cache. Icons can be cached.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, file) => { if (/\.(html|js|webmanifest)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); },
}));
app.listen(PORT, () => console.log("Care calendar listening on " + PORT));
