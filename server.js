const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const upload = multer({ dest: '/tmp' }); // use /tmp for ephemeral storage (works on Render)

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = 'BILLAN2026'; // change this
const JWT_SECRET = 'change-this-secret'; // simple token, but we'll use a static token for simplicity

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // serve static files (including index.html)

// In-memory data (backed by file)
let data = {
    organizations: [],
    requests: []
};

// Load data from file
async function loadData() {
    try {
        const raw = await fs.readFile(DATA_FILE, 'utf8');
        data = JSON.parse(raw);
    } catch (err) {
        // file doesn't exist, start empty
        data = { organizations: [], requests: [] };
    }
}

// Save data to file
async function saveData() {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// Simple token auth middleware
function authenticate(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = auth.split(' ')[1];
    // For simplicity, we use a static token – in production use JWT
    if (token !== 'bomso-admin-token') {
        return res.status(401).json({ error: 'Invalid token' });
    }
    next();
}

// Routes

// Login – returns a static token
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ token: 'bomso-admin-token' });
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
    await loadData();
    res.json(data.organizations);
});

// Add a new organization
app.post('/api/organizations', authenticate, async (req, res) => {
    const { orgCode, orgName, owner, phone, email, udc } = req.body;
    if (!orgCode || !orgName || !owner || !phone) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    await loadData();
    if (data.organizations.find(o => o.orgCode === orgCode)) {
        return res.status(400).json({ error: 'Organization code already exists' });
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
});

// Enable continue button for an organization
app.post('/api/organizations/:orgCode/enable', authenticate, async (req, res) => {
    const { orgCode } = req.params;
    await loadData();
    const org = data.organizations.find(o => o.orgCode === orgCode);
    if (!org) return res.status(404).json({ error: 'Not found' });
    org.continueEnabled = true;
    await saveData();
    res.json({ ok: true });
});

// Extend subscription by one month
app.post('/api/organizations/:orgCode/extend', authenticate, async (req, res) => {
    const { orgCode } = req.params;
    await loadData();
    const org = data.organizations.find(o => o.orgCode === orgCode);
    if (!org) return res.status(404).json({ error: 'Not found' });
    if (org.subscription && org.subscription.active && org.subscription.endDate) {
        const end = new Date(org.subscription.endDate);
        end.setMonth(end.getMonth() + 1);
        org.subscription.endDate = end.toISOString();
        await saveData();
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'No active subscription' });
    }
});

// Get all requests (optionally filter by status)
app.get('/api/requests', authenticate, async (req, res) => {
    await loadData();
    const { status } = req.query;
    let requests = data.requests;
    if (status) {
        requests = requests.filter(r => r.status === status);
    }
    res.json(requests);
});

// Create a new request (this would be called from BSMS, so no auth required)
app.post('/api/requests', async (req, res) => {
    const { orgCode, orgName, owner, phone, email, selectedTier, selectedPrice } = req.body;
    if (!orgCode || !orgName || !owner || !phone || selectedTier === undefined) {
        return res.status(400).json({ error: 'Missing fields' });
    }
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
});

// Approve a request
app.post('/api/requests/:id/approve', authenticate, async (req, res) => {
    const { id } = req.params;
    await loadData();
    const reqIndex = data.requests.findIndex(r => r.id === id);
    if (reqIndex === -1) return res.status(404).json({ error: 'Not found' });
    const request = data.requests[reqIndex];
    request.status = 'approved';
    request.approvedAt = new Date().toISOString();

    // Update organization subscription
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
});

// Reject a request
app.post('/api/requests/:id/reject', authenticate, async (req, res) => {
    const { id } = req.params;
    await loadData();
    const reqIndex = data.requests.findIndex(r => r.id === id);
    if (reqIndex === -1) return res.status(404).json({ error: 'Not found' });
    data.requests[reqIndex].status = 'rejected';
    data.requests[reqIndex].rejectedAt = new Date().toISOString();
    await saveData();
    res.json({ ok: true });
});

// Change admin password
app.post('/api/settings/password', authenticate, async (req, res) => {
    const { current, new: newPwd } = req.body;
    if (current !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Current password incorrect' });
    }
    // In a real app, you'd update the stored hash. For simplicity, we just return success.
    // To actually change, you'd need to modify the constant and restart. We'll simulate.
    res.json({ ok: true, message: 'Password changed (simulated)' });
});

// Export all data
app.get('/api/export', authenticate, async (req, res) => {
    await loadData();
    res.setHeader('Content-Disposition', 'attachment; filename=bomso_backup.json');
    res.json(data);
});

// Import data (multipart form)
app.post('/api/import', authenticate, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const filePath = req.file.path;
    const raw = await fs.readFile(filePath, 'utf8');
    try {
        const imported = JSON.parse(raw);
        if (!imported.organizations || !imported.requests) {
            throw new Error('Invalid format');
        }
        data = imported;
        await saveData();
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: 'Invalid JSON' });
    } finally {
        // clean up temp file
        await fs.unlink(filePath).catch(() => {});
    }
});

// Serve front‑end for any other route (SPA fallback)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
loadData().then(() => {
    app.listen(PORT, () => {
        console.log(`BOMSO running on port ${PORT}`);
    });
});