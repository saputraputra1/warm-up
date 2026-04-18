module.exports = {
    // Server settings
    port: 3000,
    
    // Warm-up behavior
    warmup: {
        // Delay between messages (seconds)
        minDelay: 5,
        maxDelay: 60,
        
        // Active hours (24h format)
        activeHours: {
            start: 7,   // 7 AM
            end: 23     // 11 PM
        },
        
        // Sleep hours (auto pause)
        sleepHours: {
            start: 23,
            end: 7
        },
        
        // Daily limits per account
        maxMessagesPerDay: 30,
        maxMessagesPerHour: 10,
        
        // Human behavior simulation
        typingSpeed: {
            min: 50,    // ms per character
            max: 200
        },
        typoChance: 0.1,    // 10% chance of typo
        emojiChance: 0.3,   // 30% chance of emoji
        
        // Safety
        maxConsecutiveFailures: 5,
        pauseOnHighFailure: true,
        
        // Message templates
        messageTemplates: [
            "Halo, apa kabar?",
            "Lagi sibuk?",
            "Udah makan belum?",
            "Hai, lagi ngapain?",
            "Pagi! Semangat ya",
            "Siang, lagi istirahat?",
            "Malam, gimana harinya?"
        ],
        
        // Auto-reply patterns
        autoReplies: {
            "halo": ["hai juga", "halo!", "hai, apa kabar?"],
            "hai": ["halo!", "hai juga", "ya halo"],
            "lagi apa": ["lagi santai", "kerja nih", "biasa aja"],
            "apa kabar": ["baik", "alhamdulillah baik", "sehat"],
            "lagi sibuk": ["iya nih", "lumayan", "engga kok"],
            "udah makan": ["udah", "belum nih", "baru aja"]
        },
        
        // Default reply when no pattern matches
        defaultReplies: [
            "Oh gitu ya",
            "Wah seru dong",
            "Mantap",
            "Oke sip"
        ]
    },
    
    // Database paths
    paths: {
        sessions: './data/sessions',
        logs: './data/logs.json',
        contacts: './data/contacts.csv'
    }
};
