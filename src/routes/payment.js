const express = require('express');
const router  = express.Router();
const db      = require('../database');

// ══════════════════════════════════════════════════════════════════
//  CAMPAY — MTN MoMo + Orange Money Cameroun
//  Doc : https://campay.net/api/
// ══════════════════════════════════════════════════════════════════

const CAMPAY_USERNAME = process.env.CAMPAY_USERNAME;
const CAMPAY_PASSWORD = process.env.CAMPAY_PASSWORD;
const APP_URL         = process.env.APP_URL || 'http://localhost:3000';

// demo.campay.net en test, campay.net en production
const CAMPAY_BASE = process.env.CAMPAY_ENV === 'live'
    ? 'https://campay.net/api'
    : 'https://demo.campay.net/api';

console.log(`💳 CamPay configuré (${process.env.CAMPAY_ENV === 'live' ? 'LIVE' : 'DEMO'})`);

// ─── Obtenir un token CamPay ───────────────────────────────────
async function getCampayToken() {
    const resp = await fetch(`${CAMPAY_BASE}/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: CAMPAY_USERNAME, password: CAMPAY_PASSWORD })
    });
    if (!resp.ok) throw new Error(`CamPay auth failed: ${resp.status}`);
    const data = await resp.json();
    return data.token;
}

// ─── Générer les billets et envoyer l'email ────────────────────
async function processOrder(order) {
    if (order.status === 'paid') return; // déjà traité

    db.prepare(`UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(order.id);

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
    console.log(`✅ Commande ${order.id} payée — Billets: ${ticketIds.join(', ')}`);

    try {
        const mailer = require('../mailer');
        await mailer.sendTicketEmail(order, ticketIds);
    } catch (e) {
        console.warn('Email non envoyé:', e.message);
    }
}

// ─── POST /api/payment/initiate ───────────────────────────────
// Lance la collecte CamPay (envoie USSD sur le téléphone du client)
router.post('/initiate', async (req, res) => {
    const { orderId, phone } = req.body;

    if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis' });

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order)                 return res.status(404).json({ error: 'Commande introuvable' });
    if (order.status === 'paid') return res.status(400).json({ error: 'Déjà payé' });

    // Nettoyer le numéro : enlever 237, +237, espaces
    let cleanPhone = phone.replace(/[\s\-\+]/g, '');
    if (cleanPhone.startsWith('237')) cleanPhone = cleanPhone.slice(3);

    try {
        const token = await getCampayToken();

        const body = {
            amount:             String(order.total_price),
            from:               '237' + cleanPhone,
            description:        `Nostalgia Night - ${order.qty}x PASS ${order.category}`,
            external_reference: order.id
        };

        const resp = await fetch(`${CAMPAY_BASE}/collect/`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Token ${token}`
            },
            body: JSON.stringify(body)
        });

        const data = await resp.json();
        console.log('CamPay collect response:', data);

        if (!resp.ok || data.status === 'FAILED') {
            return res.status(400).json({
                error: data.message || 'Paiement refusé',
                details: data
            });
        }

        // Sauvegarder la référence CamPay
        db.prepare("UPDATE orders SET payment_ref=? WHERE id=?")
          .run(data.reference, order.id);

        res.json({
            success:    true,
            reference:  data.reference,
            ussd_code:  data.ussd_code || null,
            message:    'Vérifiez votre téléphone et confirmez le paiement USSD'
        });

    } catch (err) {
        console.error('CamPay error:', err.message);
        res.status(500).json({ error: 'Erreur de paiement: ' + err.message });
    }
});

// ─── GET /api/payment/status/:orderId ─────────────────────────
// Polling côté client — vérifie le statut de la transaction
router.get('/status/:orderId', async (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Introuvable' });

    // Déjà payé en base
    if (order.status === 'paid') {
        const tickets = db.prepare('SELECT id FROM tickets WHERE order_id = ?').all(order.id);
        return res.json({ status: 'paid', orderId: order.id, tickets: tickets.map(t => t.id) });
    }

    // Pas encore de référence CamPay
    if (!order.payment_ref) {
        return res.json({ status: order.status });
    }

    // Interroger CamPay
    try {
        const token = await getCampayToken();
        const resp  = await fetch(`${CAMPAY_BASE}/transaction/${order.payment_ref}/`, {
            headers: { 'Authorization': `Token ${token}` }
        });
        const data = await resp.json();
        console.log(`CamPay status for ${order.payment_ref}:`, data.status);

        if (data.status === 'SUCCESSFUL') {
            await processOrder(order);
            const tickets = db.prepare('SELECT id FROM tickets WHERE order_id = ?').all(order.id);
            return res.json({ status: 'paid', orderId: order.id, tickets: tickets.map(t => t.id) });
        }

        if (data.status === 'FAILED') {
            db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(order.id);
            return res.json({ status: 'failed' });
        }

        res.json({ status: 'pending' });

    } catch (err) {
        console.error('Status check error:', err.message);
        res.json({ status: order.status });
    }
});

// ─── POST /api/payment/callback ───────────────────────────────
// Webhook CamPay — notification automatique après paiement
router.post('/callback', async (req, res) => {
    console.log('📲 Webhook CamPay reçu:', req.body);

    const { external_reference, status } = req.body;

    if (status === 'SUCCESSFUL' && external_reference) {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(external_reference);
        if (order) await processOrder(order);
    }

    res.sendStatus(200);
});

module.exports = router;
