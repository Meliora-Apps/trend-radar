// Varianta online: logare cu Google (Convex Auth, doar emailurile din lista), apoi aceeasi interfata ca local.
import { ConvexHttpClient } from 'convex/browser';
import '../src/local/public/style.css';
import './web.css';
import { makeRemoteApi } from './remote-api.js';

const client = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL);
const KEY = { jwt: 'tr_jwt', refresh: 'tr_refresh', verifier: 'tr_verifier', pending: 'tr_pending' };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* fara stocare */ } },
};

function setTokens(tokens) {
  store.set(KEY.jwt, tokens?.token ?? null);
  store.set(KEY.refresh, tokens?.refreshToken ?? null);
  if (tokens?.token) client.setAuth(tokens.token); else client.clearAuth();
}

// Tokenul expira dupa ~1h: la o eroare de acces incercam o data cu tokenul de reimprospatare.
let refreshing = null;
async function refresh() {
  const refreshToken = store.get(KEY.refresh);
  if (!refreshToken) return false;
  refreshing ??= client.action('auth:signIn', { refreshToken })
    .then((r) => { setTokens(r.tokens ?? null); return !!r.tokens; })
    .catch(() => { setTokens(null); return false; })
    .finally(() => { refreshing = null; });
  return refreshing;
}
const authError = (err) => /NOT_ALLOWED|Unauthenticated|token|expired|auth/i.test(String(err?.data ?? err?.message ?? err));
const withAuth = (call) => async (name, args) => {
  try { return await call(name, args); } catch (err) {
    if (!authError(err) || !(await refresh())) throw err;
    return call(name, args);
  }
};
const convex = {
  query: withAuth((n, a) => client.query(n, a)),
  action: withAuth((n, a) => client.action(n, a)),
  mutation: withAuth((n, a) => client.mutation(n, a)),
};

async function signIn() {
  const r = await client.action('auth:signIn', { provider: 'google', params: { redirectTo: location.origin + location.pathname } });
  store.set(KEY.verifier, r.verifier);
  store.set(KEY.pending, '1');
  location.href = r.redirect;
}

async function signOut() {
  try { await client.action('auth:signOut', {}); } catch { /* deja iesit */ }
  setTokens(null);
  location.reload();
}

function loginScreen(message) {
  document.body.classList.add('locked');
  const box = document.createElement('div');
  box.className = 'login';
  box.innerHTML = `<div class="card login-card">
    <div class="brand">Trend<span>Radar</span></div>
    <p class="muted">Cuvintele care cresc în App Store, nișele și aplicațiile care explodează.</p>
    ${message ? `<div class="notice">${message}</div>` : ''}
    <button type="button" id="google">Intră cu Google</button>
    <p class="muted small">Acces doar pentru emailurile aprobate.</p></div>`;
  document.body.append(box);
  box.querySelector('#google').addEventListener('click', (e) => {
    e.target.disabled = true; e.target.textContent = 'Se deschide Google…';
    signIn().catch((err) => { e.target.disabled = false; e.target.textContent = 'Intră cu Google'; alertBox(box, err); });
  });
}
const alertBox = (box, err) => { box.querySelector('.login-card').insertAdjacentHTML('beforeend', `<div class="notice">Eroare: ${String(err.message ?? err)}</div>`); };

async function start() {
  // Intoarcerea de la Google: ?code=... se schimba pe tokenuri.
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const pending = store.get(KEY.pending);
  store.set(KEY.pending, null);
  if (code) {
    url.searchParams.delete('code');
    history.replaceState(null, '', url);
    try {
      const r = await client.action('auth:signIn', { params: { code }, verifier: store.get(KEY.verifier) ?? undefined });
      setTokens(r.tokens ?? null);
    } catch {
      setTokens(null);
    }
    store.set(KEY.verifier, null);
  } else if (store.get(KEY.jwt)) {
    client.setAuth(store.get(KEY.jwt));
  }

  let me = null;
  if (store.get(KEY.jwt) || store.get(KEY.refresh)) me = await convex.query('data:me', {}).catch(() => null);
  if (!me?.email) {
    setTokens(null);
    return loginScreen(pending || code ? 'Logarea nu a mers: emailul tău nu e pe lista de acces.' : '');
  }

  const remote = makeRemoteApi(convex);
  globalThis.TR_API = remote.api;
  globalThis.TR_CSV = (href) => remote.csv(href).catch((err) => alert(err.message));
  const foot = document.querySelector('.side-foot');
  foot.querySelector('#refresh').textContent = 'Reîncarcă datele';
  foot.insertAdjacentHTML('beforeend', `<p class="muted small who">${me.email} · <a href="#" id="signout">Ieșire</a></p>`);
  foot.querySelector('#signout').addEventListener('click', (e) => { e.preventDefault(); signOut(); });
  if (!me.gen) document.querySelector('#notice').innerHTML = '<div class="notice">Datele încă n-au fost publicate online. Apar după prima colectare.</div>';
  await import('../src/local/public/app.js');
}

// Doar in `npm run web` (dezvoltare, Convex local cu DEV_LOGIN_SECRET): logare de test fara Google.
if (import.meta.env.DEV) {
  globalThis.__trDevLogin = async (email, secret) => {
    const r = await client.action('auth:signIn', { provider: 'dev', params: { email, secret } });
    setTokens(r.tokens ?? null);
    return !!r.tokens;
  };
}

start().catch((err) => loginScreen(`Eroare: ${err.message}`));
