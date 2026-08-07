# LifeLink — Emergency Blood Donor Matching

A web app that connects hospitals facing blood shortages with nearby donors who
can help. Three roles in one place: donors register and respond, hospitals
broadcast shortage alerts, and an administrator verifies everyone.

**Live:** https://lifelink-0002.web.app

Built for the Colombo District Emergency Response pilot proposal — Team Spartans.

---

## How it works

```
Donor registers ──► Admin verifies the uploaded document ──► Donor is matchable
                                                                    │
Hospital broadcasts a shortage alert                                │
        │                                                           │
        └─► every donor is scored against 6 checks ────────────────►│
              verified · blood group · district · active ·          │
              donation interval · 24h notification cooldown         │
                                    │                               │
                    only donors passing all six are auto-notified ──┘
                                    │
                    Donor accepts ──► donation logged, hospital stock +1,
                                      donor's 4-month interval restarts
```

The checklist is visible to hospitals per donor, so it's always clear *why*
someone was or wasn't contacted.

---

## Roles

**Donor** — registers with NIC, blood group, district and an optional donor card
or lab report. Sees only alerts they qualify for, with a live eligibility
countdown. Can export their data as JSON or delete their account at any time.

**Hospital** — signs in with an authorisation code issued by an admin. Manages
blood stock, broadcasts shortage alerts, and sees the ranked donor list with each
donor's pass/fail checklist.

**Admin** — verifies or rejects donor documents with a reason, issues hospital
codes, and sees district-wide reports and analytics.

---

## Running it locally

1. Double-click **`serve.bat`**
2. Open **http://127.0.0.1:5500**

> Opening `index.html` directly will not work — browsers block JavaScript modules
> loaded from `file://`, so it has to be served over `http://`.

**`check.html`** (at http://127.0.0.1:5500/check.html) tests every part of the
Firebase connection and names exactly what to fix if something is wrong.

---

## Firebase setup

The app needs a Firebase project. Free tier, no card required.

1. **Create the project** at https://console.firebase.google.com — Analytics off.
2. **Authentication** → *Get started* → **Sign-in method** tab:
   - **Email/Password** → enable the first toggle → Save
   - **Add new provider** → **Anonymous** → enable → Save
3. **Firestore Database** → *Create database* → nearest location → **Production mode**.
4. **Storage** → *Get started* (optional — needed only for document uploads).
5. **Project settings** → *Your apps* → web `</>` → copy the `firebaseConfig`
   values into **`js/config.js`**, keeping the word `export`.
6. **Firestore Database → Rules** → paste all of `firestore.rules` → **Publish**.
   **Storage → Rules** → paste all of `storage.rules` → **Publish**.

### Creating the first administrator

Open the **Admin** tab → **"First time? Create the administrator"** → choose an
email and password. This can only be done once; afterwards it's a normal sign-in.

Alternatively create it in the console under **Authentication → Users → Add user**.

---

## Publishing updates

Double-click **`deploy.bat`**. It installs the Firebase CLI the first time, opens
a browser to sign in, and uploads the site. Needs Node.js from https://nodejs.org.

### Links to share

| Audience | Link |
|---|---|
| Everyone | `https://lifelink-0002.web.app` |
| Donors | `https://lifelink-0002.web.app/?role=donor` |
| Hospitals | `https://lifelink-0002.web.app/?role=hospital` |
| Admins | `https://lifelink-0002.web.app/?role=admin` |

Hospital authorisation codes *are* the login — send them privately, not in a
group chat.

---

## Project structure

```
├── index.html          The whole interface — three roles, tabbed panels
├── style.css           Design system
├── check.html          Firebase connection diagnostic
├── js/
│   ├── config.js       Firebase keys
│   └── app.js          All application logic
├── firestore.rules     Database permissions
├── storage.rules       Document permissions
├── firebase.json       Hosting configuration
├── serve.bat           Run locally
└── deploy.bat          Publish online
```

Firebase config keys are safe to commit publicly — they identify the project but
grant no access. Access is controlled entirely by the two `.rules` files.

---

## Known limits

This is a pilot prototype, not a deployed medical system.

- **Any signed-in visitor can read the donor collection.** NIC and phone numbers
  are masked throughout the interface, but the underlying records are not
  restricted per-user. Fine for a demo; needs tightening before real donor data.
- **Donor and hospital logins are identifiers, not passwords** — an NIC and a
  hospital code respectively. Only the admin account has a real password.
- **Notifications are in-app only.** Real deployment needs SMS or push, since
  donors won't have the page open during an emergency.
- **No blood unit expiry tracking.** Whole blood is viable roughly 35–42 days.
- **Verification is manual.** Production would integrate with NBTS records.

---

## Credits

Interface design and original prototype by **Thejan Fernando**
([LIFELINK](https://github.com/thejanfernando-05/LIFELINK)).
Matching rules, verification workflow and Firebase backend by **Team Spartans**.
