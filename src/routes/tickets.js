const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const QRCode   = require('qrcode');
const PDFDoc   = require('pdfkit');
const db       = require('../database');
const mailer   = require('../mailer');

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

// ─── GET /api/tickets/download/:ticketId ───────────────────────
router.get('/download/:ticketId', async (req, res) => {
    const ticket = db.prepare(`
        SELECT t.*, o.email, o.phone, o.payment_method
        FROM tickets t JOIN orders o ON t.order_id = o.id
        WHERE t.id = ?
    `).get(req.params.ticketId);

    if (!ticket) return res.status(404).json({ error: 'Billet introuvable' });

    const qrContent = JSON.stringify({
        id: ticket.id, nom: ticket.prenom + ' ' + ticket.nom.toUpperCase(),
        cat: ticket.category, event: 'NOSTALGIA-NIGHT-2026', date: '18-07-2026'
    });
    const qrDataUrl = await QRCode.toDataURL(qrContent, {
        width: 200, margin: 1,
        color: { dark: '#000000', light: '#ffffff' }
    });

    // Générer le PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="billet-${ticket.id}.pdf"`);

    const doc = new PDFDoc({ size: [566, 200], margin: 0, layout: 'landscape' });
    doc.pipe(res);

    const isVIP = ticket.category === 'VIP';

    // Fond noir
    doc.rect(0, 0, 566, 200).fill('#050505');

    // Barre de couleur top
    doc.rect(0, 0, 189, 5).fill('#FF1493');
    doc.rect(189, 0, 188, 5).fill('#9B59B6');
    doc.rect(377, 0, 189, 5).fill('#00FFFF');

    // Bordure rose
    doc.rect(8, 8, 550, 184).stroke('#FF1493');

    // Fond section gauche
    doc.rect(8, 8, 368, 184).fill('#0a0a10');

    // Titre
    doc.font('Helvetica-Bold').fontSize(32).fill('#FF1493').text('NOSTALGIA NIGHT', 22, 26);
    doc.font('Helvetica').fontSize(9).fill('#888888').text('SOIRÉE ANNÉES 90  ·  BILLETTERIE OFFICIELLE', 22, 63);

    // Badge catégorie
    doc.rect(22, 73, isVIP ? 58 : 85, 16).fill(isVIP ? '#FF1493' : '#00CCCC');
    doc.font('Helvetica-Bold').fontSize(8).fill('#000').text(isVIP ? 'PASS VIP' : 'PASS CLASSIC', 26, 77);

    // Séparateur
    doc.moveTo(22, 98).lineTo(364, 98).stroke('#2a2a2a');

    // Infos - col 1
    const y1 = 108;
    doc.font('Helvetica').fontSize(7).fill('#888').text('TITULAIRE', 22, y1);
    doc.font('Helvetica-Bold').fontSize(12).fill('#fff').text((ticket.prenom + ' ' + ticket.nom).toUpperCase(), 22, y1 + 10);
    doc.font('Helvetica').fontSize(7).fill('#888').text('DATE', 22, y1 + 32);
    doc.font('Helvetica-Bold').fontSize(11).fill('#fff').text('18 JUILLET 2026', 22, y1 + 42);

    // Infos - col 2
    doc.font('Helvetica').fontSize(7).fill('#888').text('LIEU', 200, y1);
    doc.font('Helvetica-Bold').fontSize(11).fill('#fff').text('YAOUNDÉ, ODZA', 200, y1 + 10);
    doc.font('Helvetica').fontSize(7).fill('#888').text('INCLUS', 200, y1 + 32);
    doc.font('Helvetica-Bold').fontSize(9).fill(isVIP ? '#FF1493' : '#00CCCC').text(TICKETS[ticket.category].perks, 200, y1 + 42);

    // Pied gauche
    doc.moveTo(22, 178).lineTo(364, 178).stroke('#262626');
    doc.font('Helvetica').fontSize(7).fill('#555').text(`N° BILLET : ${ticket.id}`, 22, 183);
    doc.text('+237 6 99 58 43 55  /  +237 6 59 27 95 93', 220, 183);

    // Ligne pointillée séparation droite
    doc.moveTo(376, 14).lineTo(376, 186).dash(4, {space: 4}).stroke('#FF1493');
    doc.undash();

    // Encoches
    doc.circle(376, 8, 8).fill('#050505');
    doc.circle(376, 192, 8).fill('#050505');

    // Section droite - fond
    doc.rect(376, 8, 182, 184).fill('#080810');

    // QR Code
    const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    doc.image(qrBuffer, 412, 24, { width: 110, height: 110 });
    doc.font('Helvetica-Bold').fontSize(7.5).fill('#888').text("SCANNER À L'ENTRÉE", 376, 142, { width: 182, align: 'center' });
    doc.font('Helvetica').fontSize(6).fill('#444').text('Billet numérique · Non remboursable', 376, 162, { width: 182, align: 'center' });
    doc.text('Valide pour 1 personne', 376, 172, { width: 182, align: 'center' });

    // Filigrane
    doc.font('Helvetica-Bold').fontSize(50).fill('#111118').text("90'S", 376, 100, { width: 182, align: 'center' });

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
