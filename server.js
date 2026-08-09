const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

// M3U Dosyasını Anlık / Canlı Okuma Fonksiyonu
function parseM3U() {
    try {
        const filePath = path.join(__dirname, 'liste.m3u');
        if (!fs.existsSync(filePath)) return { categories: [], streams: [] };
        
        // utf-8 olarak dosyayı anlık oku
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        
        let categories = new Set();
        let streams = [];
        let currentStream = {};

        lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                // Kategori Çekme
                const groupMatch = line.match(/group-title="([^"]+)"/);
                const category = groupMatch ? groupMatch[1] : "Genel";
                categories.add(category);

                // Görsel Çekme
                const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                const logo = logoMatch ? logoMatch[1] : "";

                // İsim Çekme
                const titleParts = line.split(',');
                const name = titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : "Yayın";

                currentStream = { name, category, logo };
            } else if (line.startsWith('http://') || line.startsWith('https://')) {
                if (currentStream.name) {
                    currentStream.url = line;
                    streams.push(currentStream);
                    currentStream = {};
                }
            }
        });

        return { categories: Array.from(categories), streams };
    } catch (e) {
        return { categories: [], streams: [] };
    }
}

// Xtream API Giriş Noktası
app.get('/player_api.php', (req, res) => {
    const { username, password, action } = req.query;

    if (username !== USERNAME || password !== PASSWORD) {
        return res.status(401).json({ user_info: { auth: 0 } });
    }

    const { categories, streams } = parseM3U();

    if (!action) {
        return res.json({
            user_info: {
                username: USERNAME,
                auth: 1,
                status: "Active",
                exp_date: "1999999999",
                is_trial: "0",
                active_cons: "1",
                max_connections: "10"
            },
            server_info: {
                url: req.hostname,
                port: "80",
                https_port: "443",
                server_protocol: "https"
            }
        });
    }

    if (action === 'get_live_categories' || action === 'get_series_categories' || action === 'get_vod_categories') {
        const catList = categories.map((cat, index) => ({
            category_id: (index + 1).toString(),
            category_name: cat,
            parent_id: 0
        }));
        return res.json(catList);
    }

    if (action === 'get_live_streams' || action === 'get_series' || action === 'get_vod_streams') {
        const streamList = streams.map((s, index) => {
            const catIndex = categories.indexOf(s.category) + 1;
            return {
                num: index + 1,
                name: s.name,
                stream_id: index + 1,
                stream_type: "live",
                stream_icon: s.logo,
                category_id: catIndex.toString(),
                direct_source: s.url
            };
        });
        return res.json(streamList);
    }

    res.json([]);
});

// Yayın Oynatma
app.get('/:type/:user/:pass/:id', (req, res) => {
    const { user, pass, id } = req.params;
    if (user !== USERNAME || pass !== PASSWORD) return res.status(403).send("Yetkisiz Erişim");

    const { streams } = parseM3U();
    const cleanId = parseInt(id.replace(/\.[^/.]+$/, ""));
    const streamIndex = cleanId - 1;

    if (streams[streamIndex]) {
        return res.redirect(streams[streamIndex].url);
    }
    res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));
