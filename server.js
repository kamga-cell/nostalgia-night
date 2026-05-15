require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const db         = require('./src/database');
const ticketRoutes  = require('./src/routes/tickets');
const paymentRoutes = require('./src/routes/payment');
const adminRoutes   = require('./src/routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes API
app.use('/api/tickets',  ticketRoutes);
app.use('/api/payment',  paymentRoutes);
app.use('/api/admin',    adminRoutes);

// Serve frontend
app.get('/',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/scanner',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'scanner.html')));
app.get('/confirmation', (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirmation.html')));
app.get('/admin',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => {
    console.log(`\nðŸŽ‰ NOSTALGIA NIGHT â€” Serveur dÃ©marrÃ©`);
    console.log(`ðŸŒ Site          : http://localhost:${PORT}`);
    console.log(`ðŸ“· Scanner staff : http://localhost:${PORT}/scanner`);
    console.log(`ðŸ”§ API           : http://localhost:${PORT}/api\n`);
});

