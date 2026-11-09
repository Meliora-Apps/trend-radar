# Trend Radar (ASO)

Arată ce cuvinte-cheie caută lumea în App Store (US, GB, DE, FR, IT, ES):
ce e **nou**, ce e **în creștere**, ce are **cel mai mult trafic**, pe categorii.

Scorurile sunt **estimări** din sugestiile App Store, nu volumul oficial Apple.
Specificația: `../02-specificatie-trend-radar.md`.

## Unde rulează
Totul rulează în **Convex** (producție), singur, în fiecare zi. Site-ul: https://trend-radar.meliorapps.uk
(logare Google, doar emailurile aprobate). Nu mai e nevoie de Mac sau de GitHub Actions.

## Cum funcționează
- **Colectarea** (`convex/collect.js`, cron zilnic 03:17 UTC): cele 6 țări în paralel, fiecare pe două benzi
  care merg în paralel: cuvintele (sugestii, extindere, clasificare) și app-urile (topuri, lansări noi, lookup,
  precomenzi). Lucrul e pe bucăți de ~4 minute (o acțiune Convex are maxim 10 minute); starea fiecărei benzi e
  în tabela `jobs` (`src/collect/worker.js`), iar un paznic (cron la 10 minute) reia orice bucată căzută.
  Cererile către Apple au un ritm comun pe servicii (hints, RSS, lookup, search: `PACE` în `convex/collect.js`),
  pentru că toate ies prin aceeași adresă IP: la un 429 toți fac o pauză de 20 s și ritmul se rărește, apoi
  revine încet; ritmul atins trece de la o bucată la alta (`runs.pace`), iar nicio cerere nu pornește după
  sfârșitul bucății (rămâne pentru următoarea). Căutarea iTunes (clasificarea, precomenzile) are limita Apple de
  ~20 de cereri pe minut de pe o adresă (peste ea: 403): merge cu o cerere la 3 s (după un 403: pauză și cel mult
  una la 6 s), iar pașii cu căutare se încheie la 30 de minute de la pornirea zilei (fiecare are măcar 3 minute;
  întâi cuvintele noi și cele mai căutate). Dacă Apple refuză tot (5 refuzuri la rând într-o țară sau 12 în toate
  țările), pașii cu căutare se sar; ziua rămâne completă (cuvintele și app-urile se culeg oricum).
  Durata depinde de cât lasă Apple: cel mult ~30 de minute (plus calculul), dacă sugestiile merg cu ~5 cereri/s.
- **Calculul zilei** (`convex/process.js`, pașii în `convex/calc.js`), pe pași mici, fiecare în limitele unei
  acțiuni Convex (10 minute, 512 MB de memorie, disc temporar mic); între pași totul stă în fișiere (Convex storage):
  1. câte un pas pe țară, toate în paralel: bucățile culese devin fișierele zilei (arhiva `raw`, aceleași fișiere
     ca în `data/`); baza țării (SQLite, `src/local/db.js`, ~80 MB; copia ei e starea `db/<CC>`, iar prima dată
     se face din arhivă) primește fișierele noi; apoi planul de mâine (`plan/<CC>`) și partea țării din export:
     listele ei și bucățile pentru fișierele comune (tabela `pieces`, `src/export/split.js`);
  2. 22 de pași comuni, în paralel: `meta` + `terms`, listele ALL (5 grupe), `term/*` și `app/*` (câte 8 grupe);
  3. publicarea: site-ul trece pe generația nouă doar dacă are toate fișierele (1099); cea veche și bucățile se șterg.
  Un pas căzut se reia singur (de max. 3 ori, apoi tot calculul, de paznic); unul oprit forțat (memorie, timp) se
  reia când îi expiră rezervarea (~10 minute); unul care n-a pornit deloc (eroare a platformei: Convex nu reia singur
  o acțiune programată) se programează din nou după 2 minute. La fel o bucată de colectare care n-a pornit.
  Durata: ~1–2 minute (prima dată, cu bazele țărilor făcute din arhivă, câteva minute).
  Fișierele sunt aceleași, octet cu octet, ca exportul vechi dintr-o singură bază (`src/export/build.js`; testul
  `test/split.test.js`).
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
| `npx convex run --prod calc:last` | starea ultimului calcul, pe pași (durata, reluările, erorile) |
| `npx convex run --prod process:run '{"date":"YYYY-MM-DD"}'` | refă calculul zilei (din arhivă) și publică exportul |
| `npx convex run --prod store:note '{"date":"YYYY-MM-DD","log":["..."]}'` | o notă în jurnalul zilei (ex. după un calcul cu `remote-calc.js`) |
| `CONVEX_SITE_URL=... INGEST_SECRET=... node src/export/remote-calc.js` | rezervă: face calculul zilei pe acest calculator (bazele țărilor din Convex sau din arhivă, fișierele noi din arhivă, planul de mâine, copiile bazelor înapoi în Convex) și publică exportul |
| `CONVEX_SITE_URL=... INGEST_SECRET=... npm run upload` | urcă în arhivă fișiere din `data/` (ex. o zi colectată de pe alt calculator cu `node src/collect/cli.js`) și recalculează |

Starea zilei: tabela `runs` din dashboard-ul Convex (status, jurnal, ritmul cererilor); a calculului: tabela `calcs`.

Variabile în Convex (producție): `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`, `INGEST_SECRET`,
`COLLECT_ENABLED=1` (doar în producție: pornește cron-ul colectării). Vercel: `CONVEX_DEPLOY_KEY`.

Lista de acces (din terminal):

```
npx convex run --prod admin:allow '{"email":"cineva@gmail.com"}'
npx convex run --prod admin:revoke '{"email":"cineva@gmail.com"}'
npx convex run --prod admin:list
```

În Google Cloud, clientul OAuth (Web) are redirect URI `https://<deployment>.convex.site/api/auth/callback/google`. `DEV_LOGIN_SECRET` se setează doar pe un Convex local, pentru teste fără Google (`npm run web`).
