const express    = require('express');
const router     = express.Router();
const { v4: uuidv4 } = require('uuid');
const QRCode     = require('qrcode');
const PDFDoc     = require('pdfkit');
const multer     = require('multer');
const Anthropic  = require('@anthropic-ai/sdk');
const db         = require('../database');
const mailer     = require('../mailer');

// ─── Multer : upload en mémoire, max 8 MB, images seulement ──────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Seules les images sont acceptées'));
    }
});

// ─── Client Claude (API key optionnelle au chargement) ───────────
function getAnthropic() {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY non configurée');
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const TICKETS = {
    CLASSIC: { price: 5000, perks: '1 BOISSON OFFERTE' },
    VIP:     { price: 8000, perks: '1 PLAT + 1 BOISSON OFFERTS' }
};

// ─── GET /api/tickets/availability ─────────────────────────────
router.get('/availability', (req, res) => {
    const sold = db.prepare(`
        SELECT category, SUM(qty) as sold
        FROM orders WHERE status = 'paid'
        GROUP BY category
    `).all();

    const availability = {
        CLASSIC: { total: 300, sold: 0 },
        VIP:     { total: 100, sold: 0 }
    };
    sold.forEach(r => {
        if (availability[r.category]) availability[r.category].sold = r.sold;
    });
    Object.keys(availability).forEach(k => {
        availability[k].available = availability[k].total - availability[k].sold;
    });
    res.json(availability);
});

// ─── POST /api/tickets/create-order ────────────────────────────
router.post('/create-order', (req, res) => {
    const { prenom, nom, email, phone, category, qty, payment_method, payment_phone } = req.body;

    // Validation
    if (!prenom || !nom || !email || !phone || !category || !qty || !payment_method || !payment_phone)
        return res.status(400).json({ error: 'Tous les champs sont obligatoires' });

    if (!['CLASSIC','VIP'].includes(category))
        return res.status(400).json({ error: 'Catégorie invalide' });

    if (!['MTN','ORANGE'].includes(payment_method))
        return res.status(400).json({ error: 'Méthode de paiement invalide' });

    if (qty < 1 || qty > 10)
        return res.status(400).json({ error: 'Quantité invalide (1-10)' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Email invalide' });

    const t = TICKETS[category];
    const orderId = 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + uuidv4().slice(0,4).toUpperCase();

    db.prepare(`
        INSERT INTO orders (id, prenom, nom, email, phone, category, qty, unit_price, total_price, payment_method, payment_phone, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(orderId, prenom.trim(), nom.trim(), email.trim(), phone.trim(), category, qty, t.price, t.price * qty, payment_method, payment_phone.trim());

    res.json({ orderId, total: t.price * qty, category, qty });
});

// ─── POST /api/tickets/confirm/:orderId ────────────────────────
// Appelé après confirmation du paiement Mobile Money
router.post('/confirm/:orderId', async (req, res) => {
    const { orderId } = req.params;
    const { payment_ref } = req.body;

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });
    if (order.status === 'paid') return res.status(400).json({ error: 'Déjà payé' });

    // Marquer comme payé
    db.prepare(`
        UPDATE orders SET status='paid', payment_ref=?, paid_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(payment_ref || 'MANUAL-' + Date.now(), orderId);

    // Générer les billets
    const tickets = [];
    const insertTicket = db.prepare(`
        INSERT INTO tickets (id, order_id, prenom, nom, category)
        VALUES (?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < order.qty; i++) {
        const ticketId = 'NN-' + Date.now().toString(36).toUpperCase().slice(-5) +
                         '-' + uuidv4().slice(0,5).toUpperCase();
        insertTicket.run(ticketId, orderId, order.prenom, order.nom, order.category);
        tickets.push(ticketId);
    }

    // Envoyer l'email avec le billet (best-effort)
    try {
        await mailer.sendTicketEmail(order, tickets);
    } catch(e) {
        console.warn('Email non envoyé:', e.message);
    }

    res.json({ success: true, orderId, tickets });
});

// ─── POST /api/tickets/verify-payment ──────────────────────────
// Reçoit la capture d'écran du SMS de paiement, l'analyse via Claude Vision,
// et génère les billets automatiquement si le paiement est authentique.
router.post('/verify-payment', upload.single('screenshot'), async (req, res) => {
    const { orderId } = req.body;

    if (!orderId)      return res.status(400).json({ error: 'orderId manquant' });
    if (!req.file)     return res.status(400).json({ error: 'Capture d\'écran manquante' });

    // ── Récupérer la commande ──────────────────────────────────
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    // ── Si déjà payée : renvoyer les billets existants ─────────
    if (order.status === 'paid') {
        const existing = db.prepare('SELECT id FROM tickets WHERE order_id = ?').all(orderId);
        return res.json({ valid: true, ticketIds: existing.map(t => t.id), message: 'Paiement déjà confirmé' });
    }

    // ── Anti-abus : max 6 tentatives par commande ──────────────
    const attempts = db.prepare(
        'SELECT COUNT(*) as n FROM payment_verifications WHERE order_id = ?'
    ).get(orderId).n;
    if (attempts >= 6) {
        return res.status(429).json({
            error: 'Trop de tentatives (max 6). Contactez l\'organisateur : +237 6 99 58 43 55'
        });
    }

    // ── Préparer l'image pour Claude ──────────────────────────
    const imageBase64 = req.file.buffer.toString('base64');
    // Claude accepte : image/jpeg, image/png, image/gif, image/webp
    const allowedMime = ['image/jpeg','image/png','image/gif','image/webp'];
    const mediaType   = allowedMime.includes(req.file.mimetype)
        ? req.file.mimetype
        : 'image/jpeg';

    // ── Appel Claude Vision ────────────────────────────────────
    let aiResult = { valid: false, reason: 'Analyse impossible' };
    try {
        const anthropic = getAnthropic();
        const prompt =
`Tu es un vérificateur anti-fraude pour NOSTALGIA NIGHT, un événement au Cameroun.

Analyse cette image. Elle doit être un SMS ou une notification officielle de MTN MoMo ou Orange Money confirmant un transfert réussi.

Commande à vérifier :
- Montant attendu : ${order.total_price} FCFA
- Numéros autorisés : 699584355 (Orange Money, nom : Ngangoua Batracienne) OU 683222267 (MTN MoMo, nom : Miguel Fomekou)

Critères STRICTS (sois impitoyable avec les fraudes) :
1. Est-ce un vrai SMS/notification MTN MoMo ou Orange Money Cameroun ? (pas un montage Photoshop, pas une page web éditée, pas un faux)
2. Le statut indique-t-il clairement un paiement RÉUSSI / EFFECTUÉ ?
3. Le montant visible correspond-il à ${order.total_price} FCFA (tolérance ±0 FCFA) ?
4. Le numéro ou nom destinataire correspond-il à 699584355 / Ngangoua ou 683222267 / Fomekou ?

En cas de moindre doute, réponds false. La sécurité prime.

Réponds UNIQUEMENT avec du JSON valide, sans aucun texte autour :
{"valid":true,"reason":"ok","detected_amount":${order.total_price},"operator":"MTN"}
ou
{"valid":false,"reason":"explication courte en français (max 100 cars)","detected_amount":0,"operator":"INCONNU"}`;

        const response = await anthropic.messages.create({
            model:      'claude-opus-4-5',
            max_tokens: 200,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
                    { type: 'text',  text: prompt }
                ]
            }]
        });

        const raw = response.content[0]?.text?.trim() || '';
        try {
            aiResult = JSON.parse(raw);
        } catch (_) {
            const m = raw.match(/\{[\s\S]*?\}/);
            if (m) aiResult = JSON.parse(m[0]);
        }
    } catch (e) {
        console.error('Claude Vision error:', e.message);
        // Log l'erreur technique mais ne la laisse pas bloquer — réponse neutre
        db.prepare('INSERT INTO payment_verifications (order_id, result, ai_reason) VALUES (?,?,?)')
          .run(orderId, 'error', e.message);
        return res.status(503).json({
            error: 'Service de vérification temporairement indisponible. Réessayez dans quelques secondes.'
        });
    }

    // ── Logger la tentative ───────────────────────────────────
    db.prepare('INSERT INTO payment_verifications (order_id, result, ai_reason) VALUES (?,?,?)')
      .run(orderId, aiResult.valid ? 'valid' : 'rejected', aiResult.reason || '');

    if (!aiResult.valid) {
        return res.json({ valid: false, reason: aiResult.reason || 'Capture non valide — vérifiez votre screenshot.' });
    }

    // ── Paiement valide : confirmer et générer les billets ─────
    db.prepare(`UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(orderId);

    const insertTicket = db.prepare(`INSERT INTO tickets (id, order_id, prenom, nom, category) VALUES (?,?,?,?,?)`);
    const ticketIds = [];
    for (let i = 0; i < order.qty; i++) {
        const ticketId = 'NN-' + Date.now().toString(36).toUpperCase().slice(-5) +
                         '-' + uuidv4().slice(0, 5).toUpperCase();
        insertTicket.run(ticketId, orderId, order.prenom, order.nom, order.category);
        ticketIds.push(ticketId);
        // Micro-pause pour garantir l'unicité des IDs basés sur timestamp
        await new Promise(r => setTimeout(r, 2));
    }

    console.log(`✅ Paiement vérifié par IA — commande ${orderId} — billets : ${ticketIds.join(', ')}`);

    // Email best-effort
    try {
        await mailer.sendTicketEmail(order, ticketIds);
    } catch (e) {
        console.warn('Email non envoyé:', e.message);
    }

    res.json({ valid: true, ticketIds, message: `Paiement vérifié — ${ticketIds.length} billet(s) généré(s) !` });
});

// ─── GET /api/tickets/download/:ticketId ───────────────────────
router.get('/download/:ticketId', async (req, res) => {
    const ticket = db.prepare(`
        SELECT t.*, o.email, o.phone, o.payment_method, o.qty as order_qty
        FROM tickets t JOIN orders o ON t.order_id = o.id
        WHERE t.id = ?
    `).get(req.params.ticketId);

    if (!ticket) return res.status(404).json({ error: 'Billet introuvable' });

    // QR Code — encode uniquement l'ID du billet (plus léger, plus rapide à scanner)
    const qrDataUrl = await QRCode.toDataURL(ticket.id, {
        width: 260, margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'H'
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="billet-${ticket.id}.pdf"`);

    // ─── Dimensions : ticket A5 paysage élargi ───────────────────
    const W = 620, H = 260;
    const doc = new PDFDoc({ size: [W, H], margin: 0 });
    doc.pipe(res);

    const isVIP  = ticket.category === 'VIP';
    const accent = isVIP ? '#FF1493' : '#00CCFF';
    const STUB   = 430;   // limite gauche de la section QR (stub droit)

    // ── Arrière-plans ─────────────────────────────────────────────
    doc.rect(0,    0, STUB, H).fill('#07070F');  // corps principal
    doc.rect(STUB, 0, W-STUB, H).fill('#0B0B18'); // stub QR

    // ── Bande de couleur haut ─────────────────────────────────────
    doc.rect(0,    0, STUB,    4).fill(accent);
    doc.rect(STUB, 0, W-STUB,  4).fill(accent);

    // ── Bande de couleur bas ──────────────────────────────────────
    doc.rect(0,    H-4, STUB,    4).fill(isVIP ? '#8B0058' : '#006688');
    doc.rect(STUB, H-4, W-STUB,  4).fill(isVIP ? '#8B0058' : '#006688');

    // ── Bordure interne corps ─────────────────────────────────────
    doc.rect(10, 10, STUB-20, H-20)
       .lineWidth(0.8).stroke(accent + '55');

    // ── Filigrane "90'S" ─────────────────────────────────────────
    doc.save()
       .fontSize(130).fillColor('#ffffff').fillOpacity(0.025)
       .text("90'S", 60, 50, { width: 340, align: 'center' })
       .restore();

    // ── NOSTALGIA NIGHT (titre) ───────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#FF1493').fillOpacity(1)
       .text('NOSTALGIA NIGHT', 22, 22, { characterSpacing: 3 });

    // Sous-titre
    doc.font('Helvetica').fontSize(8).fillColor('#777777').fillOpacity(1)
       .text('SOIRÉE ANNÉES 90  ·  BILLETTERIE OFFICIELLE  ·  YAOUNDÉ, CAMEROUN', 22, 55, { characterSpacing: 1 });

    // ── Badge catégorie ───────────────────────────────────────────
    const badgeW = isVIP ? 74 : 96, badgeH = 18, badgeX = 22, badgeY = 68;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 3).fill(accent);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
       .text(isVIP ? '👑  PASS VIP' : '🎟  PASS CLASSIC', badgeX + 6, badgeY + 5, { characterSpacing: 1 });

    // ── Ligne séparatrice ─────────────────────────────────────────
    doc.moveTo(22, 100).lineTo(STUB - 22, 100)
       .lineWidth(0.5).stroke('#222233');

    // ── Infos principales ─────────────────────────────────────────
    const col1X = 22, col2X = 210, col3X = 330, infoY = 110;
    const lbl = (x, y, txt) =>
        doc.font('Helvetica').fontSize(7).fillColor('#666666').text(txt, x, y, { characterSpacing: 1.2 });
    const val = (x, y, txt, color) =>
        doc.font('Helvetica-Bold').fontSize(13).fillColor(color || '#FFFFFF').text(txt, x, y);
    const valSm = (x, y, txt, color) =>
        doc.font('Helvetica-Bold').fontSize(10).fillColor(color || '#FFFFFF').text(txt, x, y);

    // Titulaire
    lbl(col1X, infoY, 'TITULAIRE');
    const holderName = (ticket.prenom + ' ' + ticket.nom).toUpperCase();
    doc.font('Helvetica-Bold').fontSize(holderName.length > 22 ? 11 : 14)
       .fillColor('#FFFFFF').text(holderName, col1X, infoY + 11, { width: 170 });

    // Date + Heure
    lbl(col2X, infoY, 'DATE & HEURE');
    val(col2X, infoY + 11, '18 JUILLET 2026');
    doc.font('Helvetica').fontSize(9).fillColor('#AAAAAA').text('À partir de 20h00', col2X, infoY + 28);

    // Lieu
    lbl(col3X, infoY, 'LIEU');
    val(col3X, infoY + 11, 'YAOUNDÉ');
    doc.font('Helvetica').fontSize(9).fillColor('#AAAAAA').text('ODZA', col3X, infoY + 28);

    // ── Avantages inclus ──────────────────────────────────────────
    const perksY = 162;
    lbl(col1X, perksY, 'AVANTAGES INCLUS');
    doc.font('Helvetica-Bold').fontSize(10).fillColor(accent)
       .text(TICKETS[ticket.category].perks, col1X, perksY + 10);

    // ── Pied de page corps ────────────────────────────────────────
    doc.moveTo(22, H-26).lineTo(STUB-22, H-26)
       .lineWidth(0.4).stroke('#1a1a2e');
    doc.font('Helvetica').fontSize(6.5).fillColor('#444455')
       .text('N° ' + ticket.id, col1X, H-20, { characterSpacing: 1 });
    doc.font('Helvetica').fontSize(6.5).fillColor('#333344')
       .text('+237 6 99 58 43 55  ·  +237 6 59 27 95 93', col1X + 100, H-20, { characterSpacing: 0.5 });

    // ── Pointillés de séparation (perforation) ────────────────────
    doc.moveTo(STUB, 16).lineTo(STUB, H-16)
       .lineWidth(0.8).dash(5, { space: 5 }).stroke(accent + '88');
    doc.undash();

    // Encoches de perforation
    doc.circle(STUB, 0,   9).fill('#07070F');
    doc.circle(STUB, H,   9).fill('#07070F');

    // ── Stub QR ───────────────────────────────────────────────────
    const stubMidX = STUB + (W - STUB) / 2;

    // QR Code
    const qrSize = 118;
    const qrX    = stubMidX - qrSize / 2;
    const qrY    = 28;
    const qrBuf  = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    // Fond blanc pour le QR
    doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 4).fill('#FFFFFF');
    doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

    // Label QR
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#888888')
       .text("SCANNER À L'ENTRÉE", STUB + 2, qrY + qrSize + 14, { width: W - STUB - 4, align: 'center', characterSpacing: 1 });

    // Numéro de billet sous QR
    doc.font('Helvetica').fontSize(6).fillColor('#444444')
       .text(ticket.id, STUB + 2, qrY + qrSize + 28, { width: W - STUB - 4, align: 'center', characterSpacing: 1 });

    // Validité
    doc.font('Helvetica').fontSize(6).fillColor('#333344')
       .text('1 PERSONNE · NON REMBOURSABLE', STUB + 2, H - 22, { width: W - STUB - 4, align: 'center', characterSpacing: 0.8 });

    doc.end();
});

// ─── GET /api/tickets/order/:orderId ───────────────────────────
router.get('/order/:orderId', (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });
    const tickets = db.prepare('SELECT * FROM tickets WHERE order_id = ?').all(req.params.orderId);
    res.json({ order, tickets });
});

module.exports = router;
