const express = require('express');
const router  = express.Router();
const db      = require('../database');

// Middleware d'auth simple
function authAdmin(req, res, next) {
    const pwd = req.headers['x-admin-password'] || req.query.password;
    if (pwd !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
    next();
}

// ─── POST /api/admin/scan ───────────────────────────────────────
// Valider un billet à l'entrée
router.post('/scan', authAdmin, (req, res) => {
    const { ticketId, scanner_ip } = req.body;
    if (!ticketId) return res.status(400).json({ error: 'ticketId requis' });

    const ticket = db.prepare(`
        SELECT t.*, o.category, o.email
        FROM tickets t JOIN orders o ON t.order_id = o.id
        WHERE t.id = ?
    `).get(ticketId.toUpperCase().trim());

    if (!ticket) {
        db.prepare('INSERT INTO scan_log (ticket_id, result, scanner_ip) VALUES (?,?,?)').run(ticketId, 'invalid', scanner_ip || null);
        return res.json({ result: 'invalid', message: 'Billet introuvable ou invalide' });
    }

    if (ticket.is_used) {
        db.prepare('INSERT INTO scan_log (ticket_id, result, scanner_ip) VALUES (?,?,?)').run(ticketId, 'already_used', scanner_ip || null);
        return res.json({
            result: 'already_used',
            message: 'Ce billet a déjà été utilisé',
            ticket: { id: ticket.id, nom: ticket.prenom + ' ' + ticket.nom, category: ticket.category, used_at: ticket.used_at }
        });
    }

    // Marquer comme utilisé
    db.prepare('UPDATE tickets SET is_used=1, used_at=CURRENT_TIMESTAMP WHERE id=?').run(ticket.id);
    db.prepare('INSERT INTO scan_log (ticket_id, result, scanner_ip) VALUES (?,?,?)').run(ticketId, 'valid', scanner_ip || null);

    res.json({
        result: 'valid',
        message: 'Billet valide — Entrée autorisée',
        ticket: {
            id: ticket.id,
            nom: ticket.prenom + ' ' + ticket.nom.toUpperCase(),
            category: ticket.category,
            perks: ticket.category === 'VIP' ? '1 PLAT + 1 BOISSON' : '1 BOISSON'
        }
    });
});

// ─── GET /api/admin/stats ───────────────────────────────────────
router.get('/stats', authAdmin, (req, res) => {
    const orders = db.prepare(`
        SELECT
            COUNT(*) as total_orders,
            SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending_orders,
            SUM(CASE WHEN status='paid'    THEN 1 ELSE 0 END) as paid_orders,
            SUM(CASE WHEN status='paid' THEN total_price ELSE 0 END) as total_revenue,
            SUM(CASE WHEN status='paid' AND category='CLASSIC' THEN qty ELSE 0 END) as classic_sold,
            SUM(CASE WHEN status='paid' AND category='VIP'     THEN qty ELSE 0 END) as vip_sold,
            SUM(CASE WHEN status='paid' AND category='CLASSIC' THEN total_price ELSE 0 END) as classic_revenue,
            SUM(CASE WHEN status='paid' AND category='VIP'     THEN total_price ELSE 0 END) as vip_revenue,
            SUM(CASE WHEN status='pending' AND category='CLASSIC' THEN qty ELSE 0 END) as classic_pending,
            SUM(CASE WHEN status='pending' AND category='VIP'     THEN qty ELSE 0 END) as vip_pending
        FROM orders
    `).get();

    const scans = db.prepare(`
        SELECT
            COUNT(*) as total_scans,
            SUM(CASE WHEN result='valid'        THEN 1 ELSE 0 END) as valid_scans,
            SUM(CASE WHEN result='already_used' THEN 1 ELSE 0 END) as already_used,
            SUM(CASE WHEN result='invalid'      THEN 1 ELSE 0 END) as invalid_scans
        FROM scan_log
    `).get();

    res.json({ orders, scans });
});

// ─── POST /api/admin/test-email ────────────────────────────────
router.post('/test-email', authAdmin, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email requis' });
    try {
        const mailer = require('../mailer');
        await mailer.sendTestEmail(email);
        res.json({ success: true, message: `Email test envoyé à ${email}` });
    } catch (e) {
        console.error('Test email error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── GET /api/admin/orders ─────────────────────────────────────
router.get('/orders', authAdmin, (req, res) => {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
    res.json(orders);
});

// ─── GET /api/admin/reservations ───────────────────────────────
// Liste des réservations en attente de confirmation
router.get('/reservations', authAdmin, (req, res) => {
    const reservations = db.prepare(`
        SELECT id, prenom, nom, email, phone, category, qty, total_price, created_at, status
        FROM orders
        WHERE status = 'pending'
        ORDER BY created_at DESC
    `).all();
    res.json(reservations);
});

// ─── POST /api/admin/confirm/:orderId ──────────────────────────
// Confirmer le paiement d'une réservation → génère les billets + envoie email
router.post('/confirm/:orderId', authAdmin, async (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order)                  return res.status(404).json({ error: 'Commande introuvable' });
    if (order.status === 'paid') return res.status(400).json({ error: 'Déjà confirmée' });

    // Marquer comme payé
    db.prepare(`UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(order.id);

    // Générer les billets
    const { v4: uuidv4 } = require('uuid');
    const insertTicket = db.prepare(`
        INSERT INTO tickets (id, order_id, prenom, nom, category)
        VALUES (?, ?, ?, ?, ?)
    `);
    const ticketIds = [];
    for (let i = 0; i < order.qty; i++) {
        const ticketId = 'NN-' + Date.now().toString(36).toUpperCase().slice(-5) +
                         '-' + uuidv4().slice(0, 5).toUpperCase();
        insertTicket.run(ticketId, order.id, order.prenom, order.nom, order.category);
        ticketIds.push(ticketId);
    }

    console.log(`✅ Réservation ${order.id} confirmée — Billets: ${ticketIds.join(', ')}`);

    // Envoyer l'email avec les billets
    let emailSent = false;
    try {
        const mailer = require('../mailer');
        await mailer.sendTicketEmail(order, ticketIds);
        emailSent = true;
    } catch (e) {
        console.warn('Email non envoyé:', e.message);
    }

    res.json({
        success: true,
        orderId: order.id,
        tickets: ticketIds,
        emailSent,
        message: `Paiement confirmé — ${ticketIds.length} billet(s) généré(s) et envoyé(s) par email`
    });
});

// ─── GET /api/admin/scan-log ───────────────────────────────────
router.get('/scan-log', authAdmin, (req, res) => {
    const logs = db.prepare('SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT 200').all();
    res.json(logs);
});

module.exports = router;
