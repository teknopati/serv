const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

// TV listesini bellekte tutarak anında açılmasını sağlıyoruz
let cacheTV = [];

function loadTV() {
    try {
        const filePath = path.join(__dirname, 'tv.m3u');
        if (!fs.existsSync(filePath)) return;
        
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        
        let items = [];
        let currentItem = {};

        lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                const logo = logoMatch ? logoMatch[1] : "";

                const groupMatch = line.match(/group-title="([^"]+)"/);
                const rawGroup = groupMatch ? groupMatch[1] : "Genel";
                
                const titleParts = line.split(',');
                const rawTitle = titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : "Kanal";

                currentItem = { 
                    name: rawTitle, 
                    group: rawGroup, 
                    logo: logo 
                };
            } else if (line && !line.startsWith('#')) {
                if (currentItem.name) {
                    let cleanUrl = line;
                    const idMatch = line.match(/id=([a-zA-Z0-9_-]+)/);
                    if (idMatch) {
                        cleanUrl = `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&confirm=t`;
                    }
                    currentItem.url = cleanUrl;
                    items.push(currentItem);
                    currentItem = {};
                }
            }
        });
        cacheTV = items;
    } catch (e) {
        cacheTV = [];
    }
}

loadTV();

// 📺 XTREAM API
app.get('/player_api.php', (req, res) => {
    const { username, password, action, category_id } = req.query;

    if (username !== USERNAME || password !== PASSWORD) {
        return res.status(401).json({ user_info: { auth: 0 } });
    }

    if (!action) {
        return res.json({
            user_info: { username: USERNAME, auth: 1, status: "Active", exp_date: "1999999999" },
            server_info: { url: req.hostname, port: "80", https_port: "443", server_protocol: "https" }
        });
    }

    if (action === 'get_epg' || action === 'get_short_epg' || action === 'get_simple_data_table') {
        return res.json({ epg_listings: [] });
    }

    // 1. KATEGORİLER (Sadece tv.m3u grupları)
    if (action === 'get_live_categories') {
        if (cacheTV.length === 0) return res.json([]);
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        return res.json(cats.map((c, i) => ({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 })));
    }

    // 2. KANALLAR (Sadece seçilen kategorinin kanalları - Cihazı asla donmaz)
    if (action === 'get_live_streams') {
        if (!category_id) return res.json([]);

        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        let streams = cacheTV.map((item, index) => ({
            num: index + 1,
            name: item.name,
            stream_id: index + 1,
            stream_type: "live",
            stream_icon: item.logo,
            category_id: (cats.indexOf(item.group) + 1).toString(),
            direct_source: item.url
        }));

        return res.json(streams.filter(s => s.category_id === category_id.toString()));
    }

    res.json([]);
});

// 🎬 GÜVENLİ 302 YÖNLENDİRİCİ
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const cleanId = parseInt(id);
    if (!cleanId || !cacheTV[cleanId - 1]) {
        return res.status(404).send("Kanal bulunamadı");
    }

    const targetUrl = cacheTV[cleanId - 1].url;
    return res.redirect(302, targetUrl);
});

app.listen(PORT, () => console.log(`Normal TV Sunucusu ${PORT} portunda devrede.`));
