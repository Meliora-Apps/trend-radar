# Trend Radar (ASO)

Arată ce cuvinte-cheie caută lumea în App Store (US, GB, DE, FR, IT, ES):
ce e **nou**, ce e **în creștere**, ce are **cel mai mult trafic**, pe categorii.

Scorurile sunt **estimări** din sugestiile App Store, nu volumul oficial Apple.
Specificația: `../02-specificatie-trend-radar.md`.

## Pornire pe Mac
```
cd ~/Desktop/Alpha/ASO/trend-radar
npm start
```
Descarcă datele noi din GitHub, le importă și deschide http://localhost:4800.

## Cum funcționează
- **Cloud (GitHub Actions, zilnic 04:00 UTC):** `.github/workflows/daily.yml` rulează câte un job pe țară
  (`src/collect/`) și salvează în `data/days/<data>/<ȚARĂ>.json.gz` + `data/classify/...`.
- **Mac:** `src/local/` importă în `local.db` (SQLite, nu intră în git) și servește interfața.
- **Calcule:** `src/metrics/` (funcții pure, testate).

## Comenzi
| Comandă | Ce face |
|---|---|
| `npm start` | interfața locală |
| `npm test` | testele |
| `node src/collect/cli.js --country US --smoke` | colectare de probă locală (puține cereri) |

Rulare manuală în cloud: GitHub → Actions → daily-collect → Run workflow (bifează „smoke” pentru probă).

## Varianta online (Vercel + Convex)

Aceeași interfață, pe internet, cu logare Google doar pentru emailurile aprobate.

- **Colectarea** rămâne în GitHub Actions (`daily-collect`). După ea, `publish-online` construiește `local.db`, calculează toate listele, paginile cuvintelor și ale aplicațiilor (`src/export/build.js`, ~1.100 de fișiere comprimate, ~100 MB) și le urcă în Convex (`/ingest/file`, cu `INGEST_SECRET`). Generația veche se șterge după ce cea nouă e completă.
- **Convex** (`convex/`): logarea Google (Convex Auth), lista de acces (`allowed`), fișierele zilei (`files`, `state`) și cererile live către Apple (`apple.js`: iconițe, pagina unei aplicații, recenzii).
- **Vercel**: site-ul static din `web/` (Vite). `web/remote-api.js` răspunde la aceleași cereri ca serverul local, din fișierele Convex.

Lista de acces (din terminal):

```
npx convex run --prod admin:allow '{"email":"cineva@gmail.com"}'
npx convex run --prod admin:revoke '{"email":"cineva@gmail.com"}'
npx convex run --prod admin:list
```

Variabile în Convex (producție): `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` (adresa site-ului Vercel), `INGEST_SECRET`. Secrete GitHub: `CONVEX_SITE_URL` (`https://<deployment>.convex.site`), `INGEST_SECRET`. Vercel: `CONVEX_DEPLOY_KEY` (cheia de producție). În Google Cloud, clientul OAuth (Web) are redirect URI `https://<deployment>.convex.site/api/auth/callback/google`. `DEV_LOGIN_SECRET` se setează doar pe un Convex local, pentru teste fără Google (`npm run web`).
