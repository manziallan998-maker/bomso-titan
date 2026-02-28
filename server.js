const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { kv } = require('@vercel/kv');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BILLAN2026';
const VALID_TOKEN = 'bomso-admin-token';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serve frontend from /public

// ==================== AUTH ====================
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = auth.split(' ')[1];
  if (token !== VALID_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

// ==================== DATA LAYER (Vercel KV) ====================
// We'll store two keys:
// - "organizations" : array
// - "requests"      : array

// Helper to get data
async function getData() {
  const orgs = (await kv.get('organizations')) || [];
  const reqs = (await kv.get('requests')) || [];
  return { organizations: orgs, requests: reqs };
}

// Helper to save data
async function saveData(organizations, requests) {
  await kv.set('organizations', organizations);
  await kv.set('requests', requests);
}

// ==================== ROUTES ====================

// Health check
app.get('/test', (req, res) => {
  res.json({ message: 'BOMSO TITAN is alive!' });
});

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ token: VALID_TOKEN });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Verify token
app.get('/api/verify', authenticate, (req, res) => {
  res.json({ ok: true });
});

// Get all organizations
app.get('/api/organizations', authenticate, async (req, res) => {
  const { organizations } = await getData();
  res.json(organizations);
});

// Add a new organization
app.post('/api/organizations', authenticate, async (req, res) => {
  const { orgCode, orgName, owner, phone, email, udc } = req.body;
  if (!orgCode || !orgName || !owner || !phone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const { organizations, requests } = await getData();
  if (organizations.find(o => o.orgCode === orgCode)) {
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
  organizations.push(newOrg);
  await saveData(organizations, requests);
  res.status(201).json(newOrg);
});

// Enable continue button (manual override)
app.post('/api/organizations/:orgCode/enable', authenticate, async (req, res) => {
  const { orgCode } = req.params;
  const { organizations, requests } = await getData();
  const org = organizations.find(o => o.orgCode === orgCode);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  org.continueEnabled = true;
  await saveData(organizations, requests);
  res.json({ ok: true });
});

// Extend subscription by one month
app.post('/api/organizations/:orgCode/extend', authenticate, async (req, res) => {
  const { orgCode } = req.params;
  const { organizations, requests } = await getData();
  const org = organizations.find(o => o.orgCode === orgCode);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (!org.subscription || !org.subscription.active || !org.subscription.endDate) {
    return res.status(400).json({ error: 'No active subscription' });
  }
  const end = new Date(org.subscription.endDate);
  end.setMonth(end.getMonth() + 1);
  org.subscription.endDate = end.toISOString();
  await saveData(organizations, requests);
  res.json({ ok: true });
});

// Get all requests (optionally filter by status)
app.get('/api/requests', authenticate, async (req, res) => {
  const { status } = req.query;
  const { requests } = await getData();
  let filtered = requests;
  if (status) {
    filtered = requests.filter(r => r.status === status);
  }
  res.json(filtered);
});

// Create a new request (from BSMS – no auth)
app.post('/api/requests', async (req, res) => {
  const { orgCode, orgName, owner, phone, email, selectedTier, selectedPrice } = req.body;
  if (!orgCode || !orgName || !owner || !phone || selectedTier === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const { organizations, requests } = await getData();
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
  requests.push(newReq);
  await saveData(organizations, requests);
  console.log('✅ New request saved:', newReq.id);
  res.status(201).json({ id: newReq.id });
});

// Approve a request
app.post('/api/requests/:id/approve', authenticate, async (req, res) => {
  const { id } = req.params;
  const { organizations, requests } = await getData();
  const reqIndex = requests.findIndex(r => r.id === id);
  if (reqIndex === -1) return res.status(404).json({ error: 'Request not found' });
  const request = requests[reqIndex];
  request.status = 'approved';
  request.approvedAt = new Date().toISOString();

  const org = organizations.find(o => o.orgCode === request.orgCode);
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
  await saveData(organizations, requests);
  res.json({ ok: true });
});

// Reject a request
app.post('/api/requests/:id/reject', authenticate, async (req, res) => {
  const { id } = req.params;
  const { organizations, requests } = await getData();
  const reqIndex = requests.findIndex(r => r.id === id);
  if (reqIndex === -1) return res.status(404).json({ error: 'Request not found' });
  requests[reqIndex].status = 'rejected';
  requests[reqIndex].rejectedAt = new Date().toISOString();
  await saveData(organizations, requests);
  res.json({ ok: true });
});

// Export all data (JSON download)
app.get('/api/export', authenticate, async (req, res) => {
  const data = await getData();
  res.setHeader('Content-Disposition', 'attachment; filename=bomso_backup.json');
  res.json(data);
});

// Import data (requires JSON file upload – not implemented for brevity, but can be added)

// ==================== START SERVER (local) or EXPORT for Vercel ====================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 BOMSO TITAN running locally at http://localhost:${PORT}`);
  });
}

module.exports = app;
