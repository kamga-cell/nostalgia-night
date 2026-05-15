const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,            // SSL direct sur 465 — plus fiable que STARTTLS 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false }
});

// Vérification SMTP au démarrage du serveur
if (process.env.EMAIL_USER && process.env.EMAIL_USER !== 'votre@gmail.com') {
    transporter.verify()
        .then(() => console.log('✅ SMTP Gmail prêt (' + process.env.EMAIL_USER + ')'))
        .catch(err => console.error('❌ SMTP Gmail ERREUR:', err.message,
            '\n   → Vérifiez EMAIL_USER / EMAIL_PASS dans les variables Railway'));
}

const TICKETS = {
    CLASSIC: { perks: '🍹 1 Boisson offerte' },
    VIP:     { perks: '🍽️ 1 Plat + 1 Boisson offerts' }
};

async function sendTicketEmail(order, ticketIds) {
    if (!process.env.EMAIL_USER || process.env.EMAIL_USER === 'votre@gmail.com') {
        console.log('📧 Email ignoré (non configuré) — billets:', ticketIds.join(', '));
        return;
    }

    const baseUrl = process.env.APP_URL || 'https://web-production-5d3f9.up.railway.app';

    const ticketLinks = ticketIds.map(id =>
        `<a href="${baseUrl}/api/tickets/download/${id}"
            style="display:block;padding:12px 24px;background:#FF1493;color:#000;
                   text-decoration:none;font-weight:bold;font-family:Arial,sans-serif;
                   border-radius:4px;margin:6px 0;font-size:14px;">
            ⬇️ Télécharger billet PDF — ${id}
        </a>`
    ).join('');

    const perksHtml = TICKETS[order.category]?.perks || '';
    const isVip = order.category === 'VIP';

    await transporter.sendMail({
        from: `"Nostalgia Night 🎵" <${process.env.EMAIL_USER}>`,
        to:   order.email,
        subject: `🎫 ${order.qty > 1 ? `Vos ${order.qty} billets` : 'Votre billet'} — Nostalgia Night 18 Juillet 2026`,
        html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#050505;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-family:Arial Black,sans-serif;font-size:28px;color:#FF1493;
                  letter-spacing:6px;text-transform:uppercase;">NOSTALGIA NIGHT</div>
      <div style="color:#888;font-size:12px;letter-spacing:3px;margin-top:6px;">
        SOIRÉE ANNÉES 90 · 18 JUILLET 2026 · YAOUNDÉ, ODZA
      </div>
    </div>

    <!-- Séparateur -->
    <div style="height:1px;background:linear-gradient(90deg,transparent,#FF1493,transparent);margin-bottom:24px;"></div>

    <!-- Salutation -->
    <p style="color:#fff;font-size:16px;margin-bottom:8px;">
      Bonjour <strong style="color:#00FFFF;">${order.prenom} ${order.nom.toUpperCase()}</strong>,
    </p>
    <p style="color:#aaa;font-size:14px;margin-bottom:20px;">
      Votre paiement a été confirmé. Voici ${ticketIds.length > 1 ? 'vos billets' : 'votre billet'} pour la soirée :
    </p>

    <!-- Récap commande -->
    <div style="background:#111;border-left:4px solid ${isVip ? '#FF1493' : '#00FFFF'};
                border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:11px;color:#888;letter-spacing:2px;margin-bottom:4px;">VOTRE RÉSERVATION</div>
      <div style="font-size:22px;font-weight:bold;color:${isVip ? '#FF1493' : '#00FFFF'};margin-bottom:6px;">
        ${isVip ? '👑 PASS VIP' : '🎟 PASS CLASSIC'}
      </div>
      <div style="color:#aaa;font-size:13px;margin-bottom:4px;">${perksHtml}</div>
      <div style="color:#666;font-size:12px;">
        Quantité : <strong style="color:#fff;">${order.qty} billet${order.qty > 1 ? 's' : ''}</strong> &nbsp;·&nbsp;
        Total payé : <strong style="color:#FFD700;">${Number(order.total_price).toLocaleString('fr-FR')} FCFA</strong>
      </div>
    </div>

    <!-- Infos événement -->
    <div style="background:#0a0a0a;border:1px solid #222;border-radius:8px;
                padding:14px 20px;margin-bottom:20px;display:flex;gap:20px;flex-wrap:wrap;">
      <div style="flex:1;min-width:120px;">
        <div style="color:#888;font-size:11px;letter-spacing:1px;">📅 DATE</div>
        <div style="color:#fff;font-size:14px;font-weight:bold;margin-top:2px;">18 Juillet 2026</div>
      </div>
      <div style="flex:1;min-width:120px;">
        <div style="color:#888;font-size:11px;letter-spacing:1px;">⏰ HEURE</div>
        <div style="color:#fff;font-size:14px;font-weight:bold;margin-top:2px;">À partir de 20h00</div>
      </div>
      <div style="flex:1;min-width:120px;">
        <div style="color:#888;font-size:11px;letter-spacing:1px;">📍 LIEU</div>
        <div style="color:#fff;font-size:14px;font-weight:bold;margin-top:2px;">Yaoundé, ODZA</div>
      </div>
    </div>

    <!-- Téléchargement billets -->
    <div style="margin-bottom:24px;">
      <p style="color:#aaa;font-size:13px;margin-bottom:10px;">
        📥 Téléchargez votre/vos billet(s) PDF et présentez le <strong style="color:#00FFFF;">QR Code à l'entrée</strong> :
      </p>
      ${ticketLinks}
    </div>

    <!-- Important -->
    <div style="background:#1a0a00;border:1px solid rgba(255,204,0,.3);border-radius:8px;padding:12px 16px;margin-bottom:24px;">
      <div style="color:#FFD700;font-size:12px;font-weight:bold;margin-bottom:6px;">⚠️ IMPORTANT</div>
      <ul style="color:#aaa;font-size:12px;padding-left:16px;line-height:1.8;">
        <li>Présentez votre QR code (PDF ou photo) à l'entrée</li>
        <li>Chaque QR code est valable pour <strong>1 personne uniquement</strong></li>
        <li>Billet non remboursable · Arrivée conseillée avant 22h</li>
      </ul>
    </div>

    <!-- Séparateur -->
    <div style="height:1px;background:#1a1a1a;margin-bottom:16px;"></div>

    <!-- Footer -->
    <p style="color:#555;font-size:11px;text-align:center;line-height:1.8;">
      📞 +237 6 99 58 43 55 &nbsp;/&nbsp; +237 6 59 27 95 93<br>
      Nostalgia Night · Soirée Années 90 · Yaoundé 2026
    </p>
  </div>
</body>
</html>`
    });

    console.log(`📧 Email envoyé à ${order.email} — ${ticketIds.length} billet(s)`);
}

async function sendTestEmail(toEmail) {
    await transporter.sendMail({
        from: `"Nostalgia Night Test" <${process.env.EMAIL_USER}>`,
        to:   toEmail,
        subject: '✅ Test SMTP — Nostalgia Night',
        html: '<p>Configuration email opérationnelle !</p>'
    });
    console.log('📧 Email test envoyé à', toEmail);
}

module.exports = { sendTicketEmail, sendTestEmail };
