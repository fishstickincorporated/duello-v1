# NOTE for the bot-play slice: this guide is a leftover from the v1 copy
# and is NOT the guide for this slice — see BOTPLAY.md instead. In
# particular, this slice does NOT use SQLite, does NOT need a persistent
# disk, and requires DATABASE_URL (Postgres) at startup.

# Deploying Duello v1 — a slow, first-timer guide

This guide is for putting Duello v1 on the internet so you can open it
on your phone and play it. Nothing here is done yet. No account has
been created, no code has been uploaded, and there is no public link
yet. You will create all of that yourself, one step at a time, and
nothing goes live until you click the deploy button.

Take your time. Each step is separate. You can stop after any step and
come back later. Nothing bad happens if you stop.

## First, the honest warning — please read this before you start

The free route below is for a **playtest only**. It is not for real
users yet, and it is not for real passwords yet.

Why? On Render's free plan, the app's files are **temporary**. Every
time the service restarts, redeploys, or goes to sleep, anything saved
on its own disk is wiped — including the database file that holds
accounts, Elo, and game stats. That means:

- Accounts you create on the free version **will disappear** when the
  service restarts or you redeploy it. That is normal for free Render.
  It is not a bug in Duello.
- Use **throwaway test accounts only** on the free version. Do not
  reuse a password you use anywhere else.
- A free service also **goes to sleep after 15 minutes with no
  visitors**. The first visit after that takes about a minute to wake
  up, and you will see a Render loading page while it wakes. That is
  normal too.
- Render gives each workspace **750 free instance hours a month**.
  One small service, awake only when it is being used, fits inside
  that. If you run out, Render pauses your free services until the
  next month.

Real, permanent accounts need a different database (Postgres) and a
code change — see "Later: real permanent accounts" below. That is a
later step, not this one. For now, the goal is simply: get a link you
can open and play.

## Words you will see, in plain English

- **GitHub** — a website that stores code, like a folder online. You
  put your code there so Render can find it.
- **Repository (repo)** — that folder on GitHub. Yours will be called
  `duello-v1`.
- **Render** — a website that runs your code on a computer that stays
  on, so other people can open it in a browser.
- **Deploy** — the moment Render takes your code and starts running
  it. That is when you get a link.
- **Log** — a running list of messages from your app. If something
  goes wrong, the log is where you look first.

## What you need before you start

- This code, in the `duello-v1` folder. That part is already done.
- A GitHub account. If you do not have one, create one at github.com
  (free). You will need your GitHub login for the next steps.
- A Render account. You will create that in Step 2.
- No credit card is needed for a free Render service. If any step asks
  for a card, stop and double-check that you are still on the free
  plan. Do not enter a card unless you have decided, on purpose, to
  pay for something.

## Step 1: Put the code on GitHub

This step just copies your code into a folder on GitHub. It does not
put the app on the internet yet.

1. Open a terminal on the computer that has this code, and go into
   the folder:
   ```
   cd ~/workspace/duello-v1
   ```
2. Start Git in that folder and save a first version of the code:
   ```
   git init
   git add .
   git commit -m "Duello v1"
   ```
   Two things to check here, and they are already handled for you,
   but it is good to know: your account database file
   (`data/duello.db`) and your `node_modules` folder are **not**
   uploaded — they are listed in `.gitignore`, which tells Git to
   skip them. Your dictionary files (`data/words.txt` and
   `data/definitions.json`) **are** uploaded, on purpose — the app
   needs them to run. They are about 5 MB together.
3. Go to github.com in a browser, sign in, and create a new
   repository. Call it `duello-v1`. Leave it public or private —
   either works for Render, but private is fine and keeps the code
   to yourself. Do **not** tick the boxes that add a README or a
   license — this folder already has its own.
4. GitHub will show you a page with commands to connect your folder.
   Run the ones that look like this, replacing `YOUR-USERNAME` with
   your actual GitHub username:
   ```
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/duello-v1.git
   git push -u origin main
   ```
   If GitHub asks for a login when you push, use your GitHub
   username and a personal access token as the password, not your
   GitHub password — GitHub will explain that on screen if it comes
   up. (A token is just a long password GitHub makes for you, used
   only for pushing code.)
5. Check it worked: refresh the repository page on github.com. You
   should see files like `server.js`, `Dockerfile`, `render.yaml`,
   and this `DEPLOY.md`. If you see them, Step 1 is done. Stop here
   if you want — nothing is live yet.

## Step 2: Create a Render account

1. Go to render.com and sign up. The easiest way is "Sign up with
   GitHub" — that links your GitHub account to Render, so Render can
   see your repository in Step 3.
2. That is all for this step. Do not create any service yet. Do not
   enter a card.

## Step 3: Create the web service on Render

This is the step that actually deploys the app.

1. On the Render dashboard, click **New**, then **Web Service**.
2. If Render asks to connect a repository, pick your `duello-v1`
   repository. If Render offers to use the `render.yaml` file in the
   repo (a "Blueprint"), that is fine too — it holds the same
   settings listed below. If you are offered a choice and are not
   sure, choose the plain Web Service path and fill in the settings
   by hand:
   - **Name:** `duello-v1`
   - **Runtime / Environment:** Docker. Render should detect the
     `Dockerfile` in the repo on its own. Leave the build command
     and start command blank — the Dockerfile already contains
     them.
   - **Plan / Instance Type:** **Free**. This is the important one.
     Double-check it says Free before you go on.
   - **Region:** leave the default, or pick one near you (for
     example, Oregon or Ohio). It does not matter much for a
     playtest.
   - Do **not** set a `PORT` variable. Render sets `PORT` itself,
     and the server reads it automatically. (Locally it defaults to
     3000; on Render it will be whatever Render assigns.)
   - Do **not** add a persistent disk. Free Render services cannot
     have one, and adding one would either be rejected or push you
     onto a paid plan.
3. Click **Create Web Service** (or **Deploy**). That is the moment
   the app goes live.

## Step 4: Wait, then check it worked

1. Render will show you a build log. Wait for it to finish. The
   first build takes a few minutes. Do not worry if it looks like a
   lot of text — you are looking for two lines near the end:
   ```
   Duello v1 listening on http://localhost:3000
   Dictionary: 125684 words; definitions bundled: 43732
   ```
   The port number in that log line will say 3000 even on Render —
   that is just the log message. The app is still reached through
   the Render link, not through localhost.
2. When the service says it is live, Render will show you a link.
   It will look something like:
   ```
   https://duello-v1-xxxx.onrender.com
   ```
   The `xxxx` part will be different for you — Render adds random
   characters to make the address unique. **Do not guess this link.**
   Use the exact link Render shows you on your dashboard. That link
   is yours, and it is the one to open on your phone.
3. Open that link. If the service has been asleep, wait about a
   minute on the Render loading page. You should see the Duello
   sign-in screen, with the tile DUELLO logo.
4. Create a **test account** (throwaway email and a password you do
   not use anywhere else), sign in, and play a Competitive Bot
   game. Check that the home screen shows Play Friends and Play
   Online greyed out, and that the bot selector shows Competitive
   Bot and Fishstick with no Elo under either one.
5. If it works, congratulations — that is your v1, live, for a
   playtest. Remember: accounts on this free version will reset
   when the service restarts or redeploys. That is expected.

## If the deploy fails

Do not panic, and do not keep clicking deploy. Open the log on the
Render dashboard and look at the last few lines:

- If it says the port is already in use, or it cannot bind to a
  port: check that you did not set a `PORT` variable by hand.
  Remove it and redeploy — Render sets it for you.
- If it says a file is missing, like `data/words.txt`: check that
  Step 1 really pushed all the files. Go back to github.com and
  check that `data/words.txt` is in the repository.
- If you are not sure what the log means, copy the last 20 lines
  of the log and bring them back here. That is enough to diagnose
  it. Do not share any passwords or tokens from the log — there
  should not be any in it.

## Later: real permanent accounts (not this step)

When you are ready for accounts that survive restarts, this is what
changes — and it is a code change, not just a setting:

- The server today **only speaks SQLite** (the `data/duello.db`
  file). A Postgres schema already exists in `db/postgres-schema.sql`
  (tables for users, sessions, games, and Elo history, matching the
  SQLite tables), but the server code does **not** use it yet.
  Swapping to Postgres means rewriting the database helper section
  in `server.js` to use a Postgres client and setting a
  `DATABASE_URL`. The game logic, validation, and scoring would not
  change — but someone has to make that code change and test it.
- On Render, that would also mean creating a Render Postgres
  database. Note: a **free** Render Postgres database expires after
  30 days, so even that is not a permanent production database —
  it is another playtest step. A paid database is what makes
  accounts truly permanent.
- The other paid option on Render is a persistent disk on a paid
  web service, mounted at the app's data folder. The Dockerfile in
  this repo already handles that safely: if a fresh disk is empty,
  it copies the dictionary files into it on first boot, so the app
  still starts. Do not attach a disk to `/app/data` on a version
  of the code without that entrypoint logic — a fresh disk would
  hide the dictionary and the app would fail to start.

In short: do **not** invite real users, and do not use real
passwords, on the free Render version. Playtest first, then do the
Postgres change, then invite people.

## Other hosts, briefly (so you are not surprised)

- **Fly.io — not free for new accounts.** This repo includes a
  `fly.toml` for later, but as of a web check in October 2026,
  Fly.io has no free tier for new accounts: new signups get a short
  trial (2 VM hours or 7 days, whichever ends first), and after that
  a credit card and pay-as-you-go billing are required — roughly
  a few dollars a month for a small always-on app, plus storage.
  Check Fly.io's pricing page again before you use it, because this
  can change. If you do use Fly.io later, you also need to create
  a volume first (`fly volumes create duello_data --size 1
  --region iad`), because that is where accounts would live.
- **Vercel — do not use it with this code as-is.** Vercel runs
  apps as short-lived serverless functions, and a SQLite file does
  not survive between those runs. Accounts would vanish constantly.
  Vercel is the wrong shape for this app until the Postgres change
  is done.

## Checklist: what you still have to do yourself

Nothing below has been done for you, and nothing here requires a
tool you do not already have. Tick them off in order:

- [ ] Create a GitHub account (if you do not have one)
- [ ] Push this code to a GitHub repository called `duello-v1`
- [ ] Create a Render account (sign up with GitHub is easiest)
- [ ] Create a Web Service on Render from that repository, plan Free
- [ ] Wait for the deploy, check the log for the "listening" and
      "Dictionary: 125684 words" lines
- [ ] Open the exact link Render gives you, create a test account,
      and play a bot game
- [ ] Later, when you want permanent accounts: do the Postgres code
      change first — do not just switch a setting and expect it to work
