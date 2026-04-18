const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const csv = require('csv-parser');
const cron = require('node-cron');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    delay,
    fetchLatestBaileysVersion,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');

const config = require('./config');
const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Global state
const accounts = new Map();
const logs = [];
const contacts = new Map();
let dailyStats = {
    messagesSent: 0,
    lastReset: new Date().toDateString()
};

// Initialize directories
fs.ensureDirSync(config.paths.sessions);
fs.ensureDirSync(path.dirname(config.paths.logs));

// Load initial data
loadContacts();
loadLogs();

// API Routes

// Get all accounts status
app.get('/api/accounts', (req, res) => {
    const accountList = [];
    for (const [id, acc] of accounts) {
        accountList.push({
            id,
            name: acc.name || id,
            connected: acc.connected,
            qr: acc.qr || null,
            stats: acc.stats || {}
        });
    }
    res.json(accountList);
});

// Add new account
app.post('/api/accounts', async (req, res) => {
    const { name } = req.body;
    const accountId = `acc_${Date.now()}`;
    
    try {
        await initializeAccount(accountId, name);
        res.json({ success: true, accountId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Remove account
app.delete('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    const account = accounts.get(id);
    
    if (account && account.sock) {
        account.sock.logout();
        accounts.delete(id);
        fs.removeSync(path.join(config.paths.sessions, id));
    }
    
    res.json({ success: true });
});

// Get contacts
app.get('/api/contacts', (req, res) => {
    const contactList = Array.from(contacts.values());
    res.json(contactList);
});

// Add contact
app.post('/api/contacts', (req, res) => {
    const { number, name, priority } = req.body;
    const id = number.replace(/\D/g, '');
    
    contacts.set(id, {
        id,
        number,
        name: name || number,
        priority: priority || 1,
        lastContact: null,
        replied: false,
        messageCount: 0
    });
    
    saveContacts();
    res.json({ success: true });
});

// Import contacts from CSV
app.post('/api/contacts/import', (req, res) => {
    const results = [];
    
    fs.createReadStream(config.paths.contacts)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            results.forEach(row => {
                const id = row.number.replace(/\D/g, '');
                contacts.set(id, {
                    id,
                    number: row.number,
                    name: row.name || row.number,
                    priority: parseInt(row.priority) || 1,
                    lastContact: null,
                    replied: false,
                    messageCount: 0
                });
            });
            saveContacts();
            res.json({ success: true, count: results.length });
        });
});

// Get logs
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(logs.slice(-limit));
});

// Get daily stats
app.get('/api/stats', (req, res) => {
    // Reset daily stats if new day
    if (dailyStats.lastReset !== new Date().toDateString()) {
        dailyStats = {
            messagesSent: 0,
            lastReset: new Date().toDateString()
        };
    }
    
    res.json({
        ...dailyStats,
        totalContacts: contacts.size,
        activeAccounts: Array.from(accounts.values()).filter(a => a.connected).length
    });
});

// Manual trigger warmup
app.post('/api/warmup/start', async (req, res) => {
    const { accountId } = req.body;
    const account = accounts.get(accountId);
    
    if (!account || !account.connected) {
        return res.status(400).json({ error: 'Account not connected' });
    }
    
    // Run warmup in background
    performWarmup(accountId).catch(console.error);
    res.json({ success: true, message: 'Warmup started' });
});

// Pause warmup
app.post('/api/warmup/pause', (req, res) => {
    const { accountId } = req.body;
    const account = accounts.get(accountId);
    
    if (account) {
        account.paused = true;
    }
    
    res.json({ success: true });
});

// Resume warmup
app.post('/api/warmup/resume', (req, res) => {
    const { accountId } = req.body;
    const account = accounts.get(accountId);
    
    if (account) {
        account.paused = false;
    }
    
    res.json({ success: true });
});

// Get QR code
app.get('/api/qr/:accountId', (req, res) => {
    const { accountId } = req.params;
    const account = accounts.get(accountId);
    
    if (account && account.qr) {
        res.json({ qr: account.qr });
    } else {
        res.status(404).json({ error: 'QR not available' });
    }
});

// Account initialization
async function initializeAccount(accountId, name = '') {
    const { state, saveCreds } = await useMultiFileAuthState(
        path.join(config.paths.sessions, accountId)
    );
    
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp WarmUp', 'Chrome', '1.0.0']
    });
    
    const account = {
        id: accountId,
        name,
        sock,
        connected: false,
        qr: null,
        paused: false,
        stats: {
            messagesSent: 0,
            failures: 0,
            lastActive: null
        },
        limits: {
            daily: 0,
            hourly: 0,
            hourlyReset: Date.now()
        }
    };
    
    accounts.set(accountId, account);
    
    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            account.qr = qr;
        }
        
        if (connection === 'open') {
            account.connected = true;
            account.qr = null;
            addLog('info', accountId, 'Connected successfully');
            
            // Start warmup scheduler
            scheduleWarmup(accountId);
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            account.connected = false;
            addLog('warn', accountId, 'Connection closed');
            
            if (shouldReconnect) {
                setTimeout(() => initializeAccount(accountId, name), 5000);
            } else {
                accounts.delete(accountId);
                addLog('error', accountId, 'Logged out');
            }
        }
    });
    
    // Messages handler
    sock.ev.on('messages.upsert', async (msg) => {
        const message = msg.messages[0];
        if (!message.message || message.key.fromMe) return;
        
        const sender = message.key.remoteJid;
        const text = message.message.conversation || 
                    message.message.extendedTextMessage?.text || '';
        
        // Update contact replied status
        const contact = contacts.get(sender.replace('@s.whatsapp.net', ''));
        if (contact) {
            contact.replied = true;
            contact.lastContact = new Date().toISOString();
        }
        
        // Auto-reply if enabled
        if (!account.paused && text) {
            const reply = generateAutoReply(text.toLowerCase());
            if (reply) {
                await simulateHumanBehavior(sock, sender, reply);
                account.stats.messagesSent++;
                addLog('reply', accountId, `Replied to ${sender}`);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    return account;
}

// Warmup scheduler
function scheduleWarmup(accountId) {
    // Run every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
        await performWarmup(accountId);
    });
}

// Main warmup logic
async function performWarmup(accountId) {
    const account = accounts.get(accountId);
    if (!account || !account.connected || account.paused) return;
    
    // Check active hours
    const hour = new Date().getHours();
    if (hour < config.warmup.activeHours.start || hour >= config.warmup.activeHours.end) {
        return;
    }
    
    // Check limits
    if (account.limits.daily >= config.warmup.maxMessagesPerDay) {
        addLog('warn', accountId, 'Daily limit reached');
        return;
    }
    
    // Reset hourly limit if needed
    if (Date.now() - account.limits.hourlyReset > 3600000) {
        account.limits.hourly = 0;
        account.limits.hourlyReset = Date.now();
    }
    
    if (account.limits.hourly >= config.warmup.maxMessagesPerHour) {
        return;
    }
    
    // Get contacts to warm up (prioritize unreplied)
    const contactArray = Array.from(contacts.values());
    const priorityContacts = contactArray
        .filter(c => !c.replied)
        .sort((a, b) => b.priority - a.priority);
    
    const targetContact = priorityContacts[0];
    if (!targetContact) return;
    
    const jid = `${targetContact.id}@s.whatsapp.net`;
    
    try {
        // Generate random message
        const message = generateRandomMessage();
        
        // Simulate human behavior and send
        await simulateHumanBehavior(account.sock, jid, message);
        
        // Update stats
        targetContact.lastContact = new Date().toISOString();
        targetContact.messageCount++;
        account.stats.messagesSent++;
        account.limits.daily++;
        account.limits.hourly++;
        dailyStats.messagesSent++;
        
        addLog('success', accountId, `Sent warmup to ${targetContact.number}`);
        
        // Random delay before next
        const delayTime = randomInt(config.warmup.minDelay, config.warmup.maxDelay) * 1000;
        await delay(delayTime);
        
    } catch (error) {
        account.stats.failures++;
        addLog('error', accountId, `Failed to send to ${targetContact.number}: ${error.message}`);
        
        // Safety check
        if (account.stats.failures >= config.warmup.maxConsecutiveFailures) {
            account.paused = true;
            addLog('error', accountId, 'Paused due to high failure rate');
        }
    }
    
    saveContacts();
}

// Human behavior simulation
async function simulateHumanBehavior(sock, jid, message) {
    // Simulate typing
    const typingDelay = message.length * randomInt(
        config.warmup.typingSpeed.min,
        config.warmup.typingSpeed.max
    );
    
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
    await delay(Math.min(typingDelay, 5000));
    await sock.sendPresenceUpdate('paused', jid);
    
    // Random typo simulation
    let finalMessage = message;
    if (Math.random() < config.warmup.typoChance) {
        finalMessage = simulateTypo(message);
    }
    
    // Add random emoji
    if (Math.random() < config.warmup.emojiChance) {
        finalMessage += ' ' + getRandomEmoji();
    }
    
    // Send message
    await sock.sendMessage(jid, { text: finalMessage });
}

// Helper functions
function generateRandomMessage() {
    const templates = config.warmup.messageTemplates;
    return templates[Math.floor(Math.random() * templates.length)];
}

function generateAutoReply(text) {
    for (const [pattern, replies] of Object.entries(config.warmup.autoReplies)) {
        if (text.includes(pattern)) {
            return replies[Math.floor(Math.random() * replies.length)];
        }
    }
    
    if (text.length > 0 && Math.random() < 0.3) {
        const defaults = config.warmup.defaultReplies;
        return defaults[Math.floor(Math.random() * defaults.length)];
    }
    
    return null;
}

function simulateTypo(message) {
    if (message.length < 4) return message;
    
    const chars = message.split('');
    const pos = randomInt(0, chars.length - 1);
    const nearby = {
        'a': 's', 's': 'a', 'd': 'f', 'f': 'd',
        'g': 'h', 'h': 'g', 'j': 'k', 'k': 'j'
    };
    
    if (nearby[chars[pos]]) {
        chars[pos] = nearby[chars[pos]];
    }
    
    return chars.join('');
}

function getRandomEmoji() {
    const emojis = ['😊', '👍', '🙂', '😄', '🤔', '👋', '✨', '💪'];
    return emojis[Math.floor(Math.random() * emojis.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function addLog(type, accountId, message) {
    const log = {
        timestamp: new Date().toISOString(),
        type,
        accountId,
        message
    };
    
    logs.push(log);
    
    // Keep last 1000 logs
    if (logs.length > 1000) {
        logs.shift();
    }
    
    // Save periodically
    if (logs.length % 10 === 0) {
        saveLogs();
    }
}

function loadContacts() {
    try {
        if (fs.existsSync(config.paths.contacts)) {
            const results = [];
            fs.createReadStream(config.paths.contacts)
                .pipe(csv())
                .on('data', (data) => {
                    const id = data.number.replace(/\D/g, '');
                    contacts.set(id, {
                        id,
                        number: data.number,
                        name: data.name || data.number,
                        priority: parseInt(data.priority) || 1,
                        lastContact: data.lastContact || null,
                        replied: data.replied === 'true',
                        messageCount: parseInt(data.messageCount) || 0
                    });
                });
        }
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}

function saveContacts() {
    try {
        const lines = ['number,name,priority,lastContact,replied,messageCount'];
        for (const contact of contacts.values()) {
            lines.push(`${contact.number},${contact.name},${contact.priority},${contact.lastContact || ''},${contact.replied},${contact.messageCount}`);
        }
        fs.writeFileSync(config.paths.contacts, lines.join('\n'));
    } catch (error) {
        console.error('Error saving contacts:', error);
    }
}

function loadLogs() {
    try {
        if (fs.existsSync(config.paths.logs)) {
            const data = fs.readFileSync(config.paths.logs, 'utf8');
            logs.push(...JSON.parse(data));
        }
    } catch (error) {
        console.error('Error loading logs:', error);
    }
}

function saveLogs() {
    try {
        fs.writeFileSync(config.paths.logs, JSON.stringify(logs.slice(-500), null, 2));
    } catch (error) {
        console.error('Error saving logs:', error);
    }
}

// Start server
app.listen(config.port, () => {
    console.log(`\n🚀 WhatsApp Warm-Up Tool running on http://localhost:${config.port}`);
    console.log('📱 Open the dashboard to add accounts and start warm-up\n');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    saveContacts();
    saveLogs();
    
    for (const [id, account] of accounts) {
        if (account.sock) {
            await account.sock.logout();
        }
    }
    
    process.exit(0);
});
