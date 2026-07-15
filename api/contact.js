// Vercel Serverless Function — POST /api/contact
// Reçoit le formulaire de contact et envoie un email via Resend.
//
// Variables d'environnement (Vercel → Settings → Environment Variables) :
//   RESEND_API_KEY  → clé API depuis resend.com   (REQUIS)
//   RESEND_FROM     → expéditeur, ex "You'Com <noreply@youcom.studio>" (optionnel)

const DEST_EMAIL = "t.malen.pro@gmail.com";

// Origines autorisées à appeler l'API (anti-abus cross-site)
const ALLOWED_ORIGINS = [
  "https://youcom.business",
  "https://www.youcom.business",
  "https://youcom-business.vercel.app",
];

// Rate-limit best-effort en mémoire (par instance chaude).
// Pour un blocage strict multi-instances, brancher Vercel KV / Upstash.
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_MAX = 5; // max requêtes / IP / fenêtre
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // garde-fou mémoire
  return arr.length > RATE_MAX;
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);

  // CORS : n'autoriser QUE nos origines (pas de "*")
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Méthode non autorisée" });
  }

  // Bloque les requêtes navigateur cross-origin (Origin présent mais non autorisé)
  if (origin && !allowed) {
    return res.status(403).json({ ok: false, error: "Origine non autorisée." });
  }

  // Rate-limit par IP
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "Trop de requêtes. Réessayez dans quelques minutes." });
  }

  try {
    const body = req.body || {};

    // Anti-spam : honeypot — champ caché que seuls les bots remplissent
    if (body.website && String(body.website).trim() !== "") {
      return res.status(200).json({ ok: true }); // faux succès
    }

    // Coercition + plafonds de longueur (anti-payload géant)
    const firstname = clip(body.firstname, 100);
    const lastname = clip(body.lastname, 100);
    const email = clip(body.email, 200);
    const company = clip(body.company, 150);
    const budget = clip(body.budget, 100);
    const timeline = clip(body.timeline, 100);
    const message = clip(body.message, 5000);
    const rawSvc = body.svc;
    const services = (Array.isArray(rawSvc) ? rawSvc : rawSvc ? [rawSvc] : [])
      .slice(0, 20)
      .map((x) => clip(x, 60));

    // Validation minimale
    if (!firstname.trim() || !lastname.trim() || !email.trim() || !message.trim()) {
      return res.status(400).json({ ok: false, error: "Champs requis manquants." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Email invalide." });
    }

    const subject = `[You'Com] Nouvelle demande — ${escapeHtml(firstname)} ${escapeHtml(lastname)}`;

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0a1a2f;line-height:1.55">
        <h2 style="margin:0 0 8px;font-size:22px">Nouvelle demande — You'Com</h2>
        <p style="color:#5b6b85;margin:0 0 24px">Reçue via le formulaire de contact.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#5b6b85;width:140px">Prénom</td><td style="padding:8px 0"><strong>${escapeHtml(firstname)}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#5b6b85">Nom</td><td style="padding:8px 0"><strong>${escapeHtml(lastname)}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#5b6b85">Email</td><td style="padding:8px 0"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
          <tr><td style="padding:8px 0;color:#5b6b85">Société</td><td style="padding:8px 0">${escapeHtml(company) || "—"}</td></tr>
          <tr><td style="padding:8px 0;color:#5b6b85">Services</td><td style="padding:8px 0">${services.length ? escapeHtml(services.join(", ")) : "—"}</td></tr>
          <tr><td style="padding:8px 0;color:#5b6b85">Budget</td><td style="padding:8px 0">${escapeHtml(budget) || "—"}</td></tr>
          <tr><td style="padding:8px 0;color:#5b6b85">Timing</td><td style="padding:8px 0">${escapeHtml(timeline) || "—"}</td></tr>
        </table>
        <h3 style="margin:32px 0 8px;font-size:16px">Message</h3>
        <div style="background:#f4f9ff;border:1px solid rgba(10,26,47,.08);border-radius:12px;padding:18px;white-space:pre-wrap">${escapeHtml(message)}</div>
        <p style="margin-top:32px;color:#5b6b85;font-size:12px">Pour répondre, utilisez directement l'adresse du demandeur ci-dessus.</p>
      </div>
    `;

    const text = [
      `Nouvelle demande You'Com`,
      ``,
      `Prénom    : ${firstname}`,
      `Nom       : ${lastname}`,
      `Email     : ${email}`,
      `Société   : ${company || "—"}`,
      `Services  : ${services.length ? services.join(", ") : "—"}`,
      `Budget    : ${budget || "—"}`,
      `Timing    : ${timeline || "—"}`,
      ``,
      `Message :`,
      message,
    ].join("\n");

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("RESEND_API_KEY non définie");
      return res.status(500).json({ ok: false, error: "Configuration serveur manquante." });
    }
    const from = process.env.RESEND_FROM || "You'Com <onboarding@resend.dev>";

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [DEST_EMAIL], reply_to: email, subject, html, text }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("Resend error:", resp.status, errBody);
      return res.status(502).json({ ok: false, error: "Échec d'envoi de l'email." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erreur /api/contact:", err);
    return res.status(500).json({ ok: false, error: "Erreur interne." });
  }
};
