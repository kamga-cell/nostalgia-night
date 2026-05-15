const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

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
        `<a href="${baseUrl}/api/tickets/download/${id}" style="display:block; padding:10px 20px; background:#FF1493; color:#000; text-decoration:none; font-weight:bold; margin:5px 0;">⬇️ Télécharger billet ${id}</a>`
    ).join('');

    await transporter.sendMail({
        from: `"Nostalgia Night 🎵" <${process.env.EMAIL_USER}>`,
        to: order.email,
        subject: `🎫 Vos billets — Nostalgia Night 18 Juillet 2026`,
        html: `
        <div style="background:#050505; color:#fff; font-family:Arial,sans-serif; padding:40px; max-width:600px; margin:0 auto;">
            <h1 style="color:#FF1493; letter-spacing:4px; font-size:2rem;">NOSTALGIA NIGHT</h1>
            <p style="color:#888; letter-spacing:2px; font-size:0.85rem;">SOIRÉE ANNÉES 90 · 18 JUILLET 2026 · YAOUNDÉ, ODZA</p>
            <hr style="border-color:#333; margin:24px 0;">

            <p style="font-size:1.1rem;">Bonjour <strong style="color:#00FFFF;">${order.prenom} ${order.nom.toUpperCase()}</strong>,</p>
            <p style="color:#aaa; margin:12px 0;">Votre paiement a bien été reçu. Voici ${ticketIds.length > 1 ? 'vos billets' : 'votre billet'} :</p>

            <div style="background:#111; border-left:3px solid #FF1493; padding:16px; margin:20px 0;">
                <div style="font-size:0.75rem; color:#888; letter-spacing:2px;">CATÉGORIE</div>
                <div style="font-size:1.4rem; font-weight:bold; color:${order.category==='VIP'?'#FF1493':'#00FFFF'};">${order.category === 'VIP' ? '👑 PASS VIP' : 'PASS CLASSIC'}</div>
                <div style="margin-top:8px; color:#aaa;">${TICKETS[order.category].perks}</div>
                <div style="margin-top:8px; font-size:0.85rem; color:#666;">Quantité : ${order.qty} billet(s) · Total : ${(order.total_price).toLocaleString('fr-FR')} FCFA</div>
            </div>

            <p style="color:#888; font-size:0.9rem; margin-bottom:12px;">Téléchargez votre billet PDF et présentez le QR code à l'entrée :</p>
            ${ticketLinks}

            <hr style="border-color:#333; margin:32px 0;">
            <p style="color:#555; font-size:0.8rem;">📅 18 Juillet 2026 · 📍 Yaoundé, ODZA<br>📞 +237 6 99 58 43 55 / +237 6 59 27 95 93</p>
            <p style="color:#333; font-size:0.75rem; margin-top:16px;">Billet non remboursable · Valide pour 1 personne par billet</p>
        </div>`
    });

    console.log(`📧 Email envoyé à ${order.email}`);
}

module.exports = { sendTicketEmail };
