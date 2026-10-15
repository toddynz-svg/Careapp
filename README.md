# Care calendar

A small shared calendar for two parents to see whose weekend it is and to ask each other for swaps, weekends off, holidays and changes to care days. Each parent signs in with their own password; the other parent agrees or declines each request, and agreed changes update the calendar.

The roster follows the care arrangement for October 2026 to September 2027: alternating Friday-to-Sunday weekends, set school holiday weeks, and no roster over the Christmas and summer break (18 Dec 2026 to 21 Jan 2027). NZ public holidays are marked.

## Shared expenses

The Expenses tab is for bills you split. Add a bill with its total, due date, who pays it and how it's split (half each, or any two amounts that add up to the total). The other parent says where and when their share will be available. Each step is ticked off by the person who does it: the payer marks the bill paid, the other parent marks their share sent, and the payer confirms it arrived. The top of the tab shows who still owes whom across open bills. Bills are stored in `data/care.json` alongside the requests.

## Run it locally

```
npm install
cp .env.example .env      # then edit the names and passwords
node -e "require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const m=l.match(/^(\w+)=(.*)$/);if(m)process.env[m[1]]=m[2]});require('./server')"
```

Or simply set the variables in your shell and run `npm start`. Open http://localhost:3000.

## Put it on GitHub

```
git init
git add .
git commit -m "Care calendar"
gh repo create care-calendar --private --source=. --push
```

(Or create an empty private repo on github.com and follow its "push an existing repository" instructions.) `data/` and `.env` are ignored, so no passwords or request history go into the repo.

## Deploy on Railway

1. In Railway, **New Project → Deploy from GitHub repo** and pick the repo. It detects Node and runs `npm start`.
2. Open the service → **Variables** and add:
   - `PARENT_A_NAME` and `PARENT_B_NAME` (blue and orange on the calendar)
   - `PARENT_A_PASSWORD` and `PARENT_B_PASSWORD`
   - `SESSION_SECRET` (any long random string)
   - `DATA_DIR` = `/data`
3. Service → **Settings → Volumes → Add volume**, mount path `/data`. Without this, requests are lost on every redeploy.
4. Service → **Settings → Networking → Generate domain**. Share that URL and the orange password with your ex.

Redeploys happen automatically on every push to the repo.

## Changing the roster

- The alternating pattern: `PHASES` near the top of the script in `public/index.html`. Each phase starts on a Friday and names the Friday of a weekend that belongs to parent A (`aFri`), or `null` for a stretch with no roster.
- School holiday weeks and other set days: `BLOCKS` in the same place, as `[first day, last day, "a" or "b"]`. These win over the weekend pattern.
- Public holidays: the `HOL` list in the same place.
- Extra days outside the weekend pattern (for example the Waitangi week): the `extras` object in `data/care.json` on the volume, as `{"2027-02-01": "a", ...}`.
