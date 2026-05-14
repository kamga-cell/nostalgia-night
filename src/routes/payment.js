const express = require('express');
const router  = express.Router();
const db      = require('../database');

// ══════════════════════════════════════════════════════════════════
//  MONETBIL — MTN MoMo + Orange Money Cameroun
//  Doc : https://www.monetbil.com/developer
// ══════════════════════════════════════════════════════════════════

const SERVICE_KEY = process.env.MONETBIL_SERVICE_KEY;
const APP_URL     = process.env.APP_URL || 'http://localhost:3000';

if (!SERVICE_KEY || SERVICE_KEY.length < 10) {
    console.error('❌ MONETBIL_SERVICE_KEY manquant dans .env !');
} else {
    console.log('💳 Monetbil configuré ✅ (MTN MoMo + Orange Money)');
}

// ─── POST /api/payment/initiate ────────────────────────────────
// Retourne l'URL de paiement Monetbil
router.post('/initiate', (req, res) => {
    const { orderId } = req.body;

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order)                return res.status(404).json({ error: 'Commande introuvable' });
    if (order.status === 'paid') return res.status(400).json({ error: 'Déjà payé' });

    // Construire l'URL de paiement Monetbil
    const params = new URLSearchParams({
        amount:     String(order.total_price),
        phone:      '237' + order.payment_phone,
        phonelocked: '0',
        locale:     'fr',
        item_ref:   order.id,
        payment_ref: order.id,
        return_url: APP_URL + '/confirmation?order=' + order.id,
        notify_url: APP_URL + '/api/payment/callback',
        first_name: order.prenom,
        last_name:  order.nom,
        email:      order.email
    });

    const paymentUrl = `https://api.monetbil.com/widget/v2.1/${SERVICE_KEY}?${params.toString()}`;

    // Sauvegarder l'état en attente
    db.prepare("UPDATE orders SET status='pending', payment_ref=? WHERE id=?")
      .run('MONETBIL-' + Date.now(), order.id);

    res.json({ payment_url: paymentUrl, orderId });
});

// ─── POST /api/payment/callback ────────────────────────────────
// Webhook Monetbil — appelé après paiement du client
router.post('/callback', async (req, res) => {
    const { paytoken, status, transaction_UUID, phone_num, amount, item_ref } = req.body;

    console.log('📲 Callback Monetbil reçu:', req.body);

    if (status === 'success') {
        // Vérifier le paiement auprès de Monetbil (double vérification)
        try {
            const verified = await verifyPayment(paytoken);
            if (!verified) {
                console.warn('⚠️  Vérification Monetbil échouée pour paytoken:', paytoken);
                return res.status(400).send('verification_failed');
            }
        } catch(e) {
            console.error('Erreur vérification Monetbil:', e.message);
            // On accepte quand même si l'API de vérification est injoignable
        }

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item_ref);
        if (order && order.status !== 'paid') {
            // Marquer comme payé
            db.prepare(`UPDATE orders SET status='paid', payment_ref=?, paid_at=CURRENT_TIMESTAMP WHERE id=?`)
              .run(transaction_UUID || paytoken, order.id);

            // Générer les billets
            const { v4: uuidv4 } = require('uuid');
            const insertTicket = db.prepare(`
                INSERT INTO tickets (id, order_id, prenom, nom, category)
                VALUES (?, ?, ?, ?, ?)
            `);
            const ticketIds = [];
            for (let i = 0; i < order.qty; i++) {
                const ticketId = 'NN-' + Date.now().toString(36).toUpperCase().slice(-5) +
                                 '-' + uuidv4().slice(0,5).toUpperCase();
                insertTicket.run(ticketId, order.id, order.prenom, order.nom, order.category);
                ticketIds.push(ticketId);
            }

            console.log(`✅ Commande ${order.id} payée — Billets: ${ticketIds.join(', ')}`);

            // Envoyer l'email avec les billets
            try {
                const mailer = require('../mailer');
                await mailer.sendTicketEmail(order, ticketIds);
            } catch(e) {
                console.warn('Email non envoyé:', e.message);
            }
        }
    } else {
        // Paiement échoué ou annulé
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item_ref);
        if (order && order.status === 'pending') {
            db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(item_ref);
            console.log(`❌ Paiement échoué pour commande ${item_ref} — status: ${status}`);
        }
    }

    // Monetbil attend un 200 pour ne pas re-envoyer la notification
    res.sendStatus(200);
});

// ─── GET /api/payment/status/:orderId ──────────────────────────
router.get('/status/:orderId', (req, res) => {
    const order = db.prepare('SELECT id, status, payment_ref, paid_at FROM orders WHERE id = ?')
                    .get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Introuvable' });
    res.json(order);
});

// ─── POST /api/payment/verify-manual ───────────────────────────
// Vérification manuelle (utile en dev local)
router.post('/verify-manual', async (req, res) => {
    const { orderId, paytoken } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Introuvable' });

    try {
        const result = await verifyPayment(paytoken);
        res.json({ verified: result, status: order.status });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════════
//  VÉRIFICATION MONETBIL
// ══════════════════════════════════════════════════════════════════
async function verifyPayment(paytoken) {
    const res = await fetch('https://api.monetbil.com/payment/v1/checkPayment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paytoken })
    });
    const data = await res.json();
    // Monetbil renvoie { success: 1, transaction: {...} } si OK
    return data.success === 1 && data.transaction && data.transaction.status === 'success';
}

module.exports = router;
