// Fixture app mirroring the first A/B run's subject: a seller-dashboard login.
// Patterns are library-agnostic but copy what Ant Design-style apps do:
// empty aria-live region with the toast text in a sibling, a POST /api/login,
// a redirect on success, a welcome modal that renders 700ms after landing,
// an account menu with several menuitems, and logout redirecting to /login.
import http from "node:http";

const page = (title, body) =>
  `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
  <style>.hidden{display:none}</style></head><body>${body}</body></html>`;

const LOGIN = page(
  "Masuk - Seller Center",
  `
  <form id="login" data-testid="login-form">
    <label for="email">Email</label>
    <input id="email" data-testid="login-email" type="email" required placeholder="nama@toko.id">
    <label for="password">Kata sandi</label>
    <input id="password" data-testid="login-password" type="password" required>
    <button data-testid="login-submit" type="submit">Masuk</button>
  </form>
  <div class="notice-wrapper hidden" id="toast"><div role="alert"></div><div class="notice-message"></div></div>
  <script>
    document.getElementById('login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const res = await fetch('/api/auth/login?client=web', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ email, password }) });
      if (res.ok) { location.href = '/dashboard'; return; }
      const t = document.getElementById('toast');
      t.classList.remove('hidden');
      t.querySelector('.notice-message').textContent = 'Email atau kata sandi salah';
      setTimeout(() => t.classList.add('hidden'), 4000);
    });
  </script>`,
);

const DASHBOARD = page(
  "Dashboard - Seller Center",
  `
  <header>
    <a href="/dashboard" data-testid="logo"><img src="/logo.png" alt="Seller Center"></a>
    <button data-testid="account-menu" aria-haspopup="menu" aria-expanded="false">Toko Budi</button>
    <div role="menu" id="menu" class="hidden">
      <a role="menuitem" href="/profile">Profil</a>
      <a role="menuitem" href="/settings">Pengaturan</a>
      <a role="menuitem" href="/help" target="_blank">Bantuan</a>
      <button role="menuitem" data-testid="logout">Keluar</button>
    </div>
  </header>
  <main><h1>Ringkasan</h1><a href="/orders" data-testid="orders-link">Lihat pesanan</a></main>
  <div id="welcome" role="dialog" aria-label="Selamat datang" class="hidden">
    <p>Selamat datang kembali, Budi!</p>
    <button data-testid="welcome-close">Mulai</button>
  </div>
  <script>
    fetch('/api/seller/summary').then(() => setTimeout(() => document.getElementById('welcome').classList.remove('hidden'), 700));
    document.querySelector('[data-testid=welcome-close]').onclick = () => document.getElementById('welcome').classList.add('hidden');
    const btn = document.querySelector('[data-testid=account-menu]');
    btn.onclick = () => { const open = btn.getAttribute('aria-expanded') === 'true'; btn.setAttribute('aria-expanded', String(!open)); document.getElementById('menu').classList.toggle('hidden', open); };
    document.querySelector('[data-testid=logout]').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };
  </script>`,
);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/auth/login") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { email, password } = JSON.parse(raw || "{}");
      if (email === "budi@toko.id" && password === "rahasia123") json(200, { ok: true });
      else json(401, { error: "invalid_credentials" });
    });
    return;
  }
  if (url.pathname === "/api/auth/logout") return json(200, { ok: true });
  if (url.pathname === "/api/seller/summary") return json(200, { orders: 3 });
  if (url.pathname === "/logo.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.alloc(0)); }
  const html = { "/login": LOGIN, "/dashboard": DASHBOARD, "/": LOGIN, "/help": page("Bantuan", "<h1>Bantuan</h1>") }[url.pathname];
  if (!html) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

const port = Number(process.env.PORT || 4177);
server.listen(port, "127.0.0.1", () => console.log(`fixture app on http://127.0.0.1:${port}`));
