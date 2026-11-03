# Trend Radar (ASO)

Arată ce cuvinte-cheie caută lumea în App Store (US, GB, DE, FR, IT, ES):
ce e **nou**, ce e **în creștere**, ce are **cel mai mult trafic**, pe categorii.

Scorurile sunt **estimări** din sugestiile App Store, nu volumul oficial Apple.
Specificația: `../02-specificatie-trend-radar.md`.

## Unde rulează
Totul rulează în **Convex** (producție), singur, în fiecare zi. Site-ul: https://trend-radar.meliorapps.uk
(logare Google, doar emailurile aprobate). Nu mai e nevoie de Mac sau de GitHub Actions.

## Cum funcționează
- **Colectarea** (`convex/collect.js`, cron zilnic 03:17 UTC): cele 6 țări în paralel, pe bucăți de ~4 minute
  (o acțiune Convex are maxim 10 minute). Starea fiecărei țări e în tabela `jobs` (`src/collect/worker.js`);
  un paznic (cron la 10 minute) reia orice bucată căzută.
- **Calculul zilei** (`convex/process.js`): bucățile culese devin fișierele zilei (arhiva `raw`, aceleași
  fișiere ca în `data/`), apoi baza de calcul SQLite (`src/local/db.js`, păstrată compact în Convex)
  se actualizează și se publică exportul pentru site (`src/export/build.js`). Dacă exportul nu încape în
  10 minute, continuă automat într-o acțiune nouă. Generația veche se șterge după ce cea nouă e completă.
- **Planul zilei următoare** (`src/compute/plan.js`): ce începuturi de cuvinte se extind și ce se clasifică.
- **Calcule:** `src/metrics/` (funcții pure, testate).
- **Site-ul**: Vercel, din `web/` (Vite) + interfața din `src/local/public/`; `web/remote-api.js` citește fișierele din Convex.

## Comenzi
| Comandă | Ce face |
|---|---|
| `npm test` | testele |
| `npx convex run --prod collect:start '{"manual":true}'` | pornește colectarea de azi acum (dacă nu a pornit) |
| `npx convex run --prod collect:start '{"manual":true,"smoke":true,"date":"2000-01-01"}'` | probă scurtă (nu intră în arhivă) |
| `npx convex logs --prod` | jurnalul în timp real |
| `CONVEX_SITE_URL=... INGEST_SECRET=... npm run upload` | urcă în arhivă fișiere din `data/` (ex. o zi colectată de pe alt calculator cu `node src/collect/cli.js`) și recalculează |

Starea zilei: tabela `runs` din dashboard-ul Convex (status, jurnal).

Variabile în Convex (producție): `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`, `INGEST_SECRET`,
`COLLECT_ENABLED=1` (doar în producție: pornește cron-ul colectării). Vercel: `CONVEX_DEPLOY_KEY`.

Lista de acces (din terminal):

```
npx convex run --prod admin:allow '{"email":"cineva@gmail.com"}'
npx convex run --prod admin:revoke '{"email":"cineva@gmail.com"}'
npx convex run --prod admin:list
```

În Google Cloud, clientul OAuth (Web) are redirect URI `https://<deployment>.convex.site/api/auth/callback/google`. `DEV_LOGIN_SECRET` se setează doar pe un Convex local, pentru teste fără Google (`npm run web`).
