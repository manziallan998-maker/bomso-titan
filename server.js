// ==================== BOMSO BACKEND ====================
// Professional Node.js server for BILLAN Organisation Management Office
// Designed to run on Vercel as a serverless function
// Includes full error handling, environment config, and data persistence

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');

// ==================== CONFIGURATION ====================
const app = express();
const PORT = process.env.PORT || 3000; // for local development only
const DATA_FILE = path.join(__dirname, 'data.json');
// Admin password – set via environment variable on Vercel, fallback for local dev
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BILLAN2026';
// Simple static token – in production, use JWT with a secret
const VALID_TOKEN = 'bomso-admin-token';

// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Simple CORS – allow all origins (adjust if needed)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ==================== DATA LAYER ====================
// In-memory data, backed by a JSON file
let data = {
    organizations: [],
    requests: []
};

// Load data from file (async, with error handling)
async function loadData() {
    try {
        const raw = await fs.readFile(DATA_FILE, 'utf8');
        data = JSON.parse(raw);
        console.log('✅ Data loaded from file');
    } catch (err) {
        if (err.code === 'ENOENT') {
            // File doesn't exist – start with empty data, will be created on first save
            console.log('ℹ️ No data file found, starting fresh');
            data = { organizations: [], requests: [] };
        } else {
            console.error('❌ Error loading data:', err);
            // Keep existing in-memory data (if any) – but we'll reset to empty to avoid corruption
            data = { organizations: [], requests: [] };
        }
    }
}

// Save data to file (async, with error handling)
async function saveData() {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
        console.log('✅ Data saved');
    } catch (err) {
        console.error('❌ Error saving data:', err);
        // We don't throw – we'll just log and continue
    }
}

// ==================== AUTH MIDDLEWARE ====================
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== VALID_TOKEN) {
        return res.status(403).json({ error: 'Invalid token' });
    }
    next();
}

// ==================== ROUTES ====================

// Health check / root – serve the HTML interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Login – returns a static token (for simplicity)
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ token: VALID_TOKEN });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// Verify token (for auto-login)
app.get('/api/verify', authenticate, (req, res) => {
    res.json({ ok: true });
});

// Get all organizations
app.get('/api/organizations', authenticate, async (req, res) => {
    try {
        await loadData();
        res.json(data.organizations);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add a new organization
app.post('/api/organizations', authenticate, async (req, res) => {
    const { orgCode, orgName, owner, phone, email, udc } = req.body;
    if (!orgCode || !orgName || !owner || !phone) {
        return res.status(400).json({ error: 'Missing required fields: orgCode, orgName, owner, phone' });
    }
    try {
        await loadData();
        if (data.organizations.find(o => o.orgCode === orgCode)) {
            return res.status(409).json({ error: 'Organization code already exists' });
        }
        const newOrg = {
            orgCode,
            orgName,
            owner,
            phone,
            email: email || '',
            udc: udc || '',
            subscription: { active: false, startDate: null, endDate: null, tier: null },
            continueEnabled: false,
            createdAt: new Date().toISOString()
        };
        data.organizations.push(newOrg);
        await saveData();
        res.status(201).json(newOrg);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Enable continue button for an organization
app.post('/api/organizations/:orgCode/enable', authenticate, async (req, res) => {
    const { orgCode } = req.params;
    try {
        await loadData();
        const org = data.organizations.find(o => o.orgCode === orgCode);
        if (!org) {
            return res.status(404).json({ error: 'Organization not found' });
        }
        org.continueEnabled = true;
        await saveData();
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Extend subscription by one month
app.post('/api/organizations/:orgCode/extend', authenticate, async (req, res) => {
    const { orgCode } = req.params;
    try {
        await loadData();
        const org = data.organizations.find(o => o.orgCode === orgCode);
        if (!org) {
            return res.status(404).json({ error: 'Organization not found' });
        }
        if (!org.subscription || !org.subscription.active || !org.subscription.endDate) {
            return res.status(400).json({ error: 'No active subscription to extend' });
        }
        const end = new Date(org.subscription.endDate);
        end.setMonth(end.getMonth() + 1);
        org.subscription.endDate = end.toISOString();
        await saveData();
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all requests (optionally filter by status)
app.get('/api/requests', authenticate, async (req, res) => {
    const { status } = req.query;
    try {
        await loadData();
        let requests = data.requests;
        if (status) {
            requests = requests.filter(r => r.status === status);
        }
        res.json(requests);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a new request (called from BSMS – no authentication required)
app.post('/api/requests', async (req, res) => {
    const { orgCode, orgName, owner, phone, email, selectedTier, selectedPrice } = req.body;
    if (!orgCode || !orgName || !owner || !phone || selectedTier === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        await loadData();
        const newReq = {
            id: 'REQ-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
            orgCode,
            orgName,
            owner,
            phone,
            email: email || '',
            selectedTier,
            selectedPrice: selectedPrice || 0,
            timestamp: new Date().toISOString(),
            status: 'pending'
        };
        data.requests.push(newReq);
        await saveData();
        res.status(201).json({ id: newReq.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Approve a request
app.post('/api/requests/:id/approve', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        await loadData();
        const requestIndex = data.requests.findIndex(r => r.id === id);
        if (requestIndex === -1) {
            return res.status(404).json({ error: 'Request not found' });
        }
        const request = data.requests[requestIndex];
        request.status = 'approved';
        request.approvedAt = new Date().toISOString();

        // Update the corresponding organization's subscription
        const org = data.organizations.find(o => o.orgCode === request.orgCode);
        if (org) {
            const startDate = new Date();
            const endDate = new Date();
            const days = request.selectedTier === 0 ? 7 : request.selectedTier * 30;
            endDate.setDate(endDate.getDate() + days);
            org.subscription = {
                active: true,
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                tier: request.selectedTier === 0 ? 'trial' : request.selectedTier + 'months'
            };
            org.continueEnabled = true;
        }
        await saveData();
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Reject a request
app.post('/api/requests/:id/reject', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        await loadData();
        const requestIndex = data.requests.findIndex(r => r.id === id);
        if (requestIndex === -1) {
            return res.status(404).json({ error: 'Request not found' });
        }
        data.requests[requestIndex].status = 'rejected';
        data.requests[requestIndex].rejectedAt = new Date().toISOString();
        await saveData();
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Change admin password (for simplicity, we just simulate – in production you'd update env var or a hash)
app.post('/api/settings/password', authenticate, async (req, res) => {
    const { current, new: newPwd } = req.body;
    if (current !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    // In a real app, you'd update a hashed password in a secure store.
    // Here we just return a success message.
    res.json({ ok: true, message: 'Password changed (simulated). To actually change, update the ADMIN_PASSWORD environment variable on Vercel.' });
});

// Export all data as JSON file
app.get('/api/export', authenticate, async (req, res) => {
    try {
        await loadData();
        res.setHeader('Content-Disposition', 'attachment; filename=bomso_backup.json');
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Import data via file upload
const uploadMiddleware = multer({ dest: '/tmp' }).single('file');
app.post('/api/import', authenticate, (req, res) => {
    uploadMiddleware(req, res, async (err) => {
        if (err) {
            console.error('Upload error:', err);
            return res.status(500).json({ error: 'File upload failed' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        try {
            const filePath = req.file.path;
            const raw = await fs.readFile(filePath, 'utf8');
            const imported = JSON.parse(raw);
            if (!imported.organizations || !imported.requests) {
                throw new Error('Invalid JSON structure – missing organizations or requests');
            }
            data = imported;
            await saveData();
            res.json({ ok: true, message: 'Data imported successfully' });
        } catch (parseErr) {
            console.error('Import error:', parseErr);
            res.status(400).json({ error: 'Invalid JSON file' });
        } finally {
            // Clean up uploaded file
            try { await fs.unlink(req.file.path); } catch (unlinkErr) { console.warn('Could not delete temp file', unlinkErr); }
        }
    });
});

// ==================== ERROR HANDLING MIDDLEWARE ====================
// Catch 404 and forward to error handler
app.use((req, res, next) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ==================== EXPORT FOR VERCEL ====================
// This is the key line that makes the serverless function work
module.exports = app;

// ==================== LOCAL DEVELOPMENT ONLY ====================
// When running locally (not on Vercel), start the server
//if (require.main === module) {
   // app.listen(PORT, () => {
       // console.log(`🚀 BOMSO running locally at http://localhost:${PORT}`);
    //});
//}

