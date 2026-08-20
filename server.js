const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200;

function readM3UFile(fileName) {
    try {
        const filePath = path.join(__dirname, fileName);
        if (!fs.existsSync(filePath)) return [];
        
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        
        let items = [];
        let currentItem = {};

        lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                const durationMatch = line.match(/#EXTINF:(-?\d+)/);
                let parsedDuration = durationMatch ? parseInt(durationMatch[1]) : -1;

                const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                const logo = logoMatch ? logoMatch[1] : "";

                const groupMatch = line.match(/group-title="([^"]+)"/);
                const rawGroup = groupMatch ? groupMatch[1] : "Genel";
                
                let seriesName = rawGroup.split('-')[0].trim();
                let season = 1;

                const seasonInGroup = rawGroup.match(/Sezon\s*(\d+)/i);
                if (seasonInGroup) season = parseInt(seasonInGroup[1]);

                const titleParts = line.split(',');
                const rawTitle = titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : "Yayın";

                let episode = 1;
                const dashMatch = rawTitle.match(/(\d+)-(\d+)/);
                const epMatch = rawTitle.match(/(?:Bölüm|E)\s*(\d+)/i);

                if (dashMatch) {
                    season = parseInt(dashMatch[1]);
                    episode = parseInt(dashMatch[2]);
                } else if (epMatch) {
                    episode = parseInt(epMatch[1]);
                }

                let partNum = 1;
                const partMatch = rawTitle.match(/(?:_P|\(Parça\s*|Parça\s*)(\d+)/i);
                if (partMatch) {
                    partNum = parseInt(partMatch[1]);
                }

                let durationInSeconds = DEFAULT_EP_DURATION;
                if (parsedDuration > 0) durationInSeconds = parsedDuration;

                currentItem = { 
                    name: rawTitle, 
                    group: rawGroup, 
                    seriesName, 
                    logo, 
                    season, 
                    episode, 
                    partNum,
                    durationInSeconds 
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

        return items;
    } catch (e) {
        return [];
    }
}

const ALPHABET_GROUPS = [
    { id: "alpha_1", name: "🔤 [ A - B - C ]", chars: ['a', 'b', 'c'] },
    { id: "alpha_2", name: "🔤 [ Ç - D - E ]", chars: ['ç', 'd', 'e'] },
    { id: "alpha_3", name: "🔤 [ F - G - Ğ ]", chars: ['f', 'g', 'ğ'] },
    { id: "alpha_4", name: "🔤 [ H - I - İ ]", chars: ['h', 'ı', 'i'] },
    { id: "alpha_5", name: "🔤 [ J - K - L ]", chars: ['j', 'k', 'l'] },
    { id: "alpha_6", name: "🔤 [ M - N - O ]", chars: ['m', 'n', 'o'] },
    { id: "alpha_7", name: "🔤 [ Ö - P - R ]", chars: ['ö', 'p', 'r'] },
    { id: "alpha_8", name: "🔤 [ S - Ş - T ]", chars: ['s', 'ş', 't'] },
    { id: "alpha_9", name: "🔤 [ U - Ü - V ]", chars: ['u', 'ü', 'v'] },
    { id: "alpha_10", name: "🔤 [ Y - Z - # ]", chars: ['y', 'z'] }
];

function getAlphabetCategoryId(channelName) {
    if (!channelName) return "alpha_10";
    const firstChar = channelName.trim().charAt(0).toLowerCase();
    for (let group of ALPHABET_GROUPS) {
        if (group.chars.includes(firstChar)) return group.id;
    }
    return "alpha_10";
}

function getAllUniqueSeries() {
    const rawItems = readM3UFile('series.m3u');
    const seriesMap = new Map();

    rawItems.forEach((item, index) => {
        const sKey = item.seriesName.toLowerCase();
        if (!seriesMap.has(sKey)) {
            seriesMap.set(sKey, {
                name: item.seriesName,
                logo: item.logo,
                items: []
            });
        }
        item.globalIndex = index;
        seriesMap.get(sKey).items.push(item);
    });

    return Array.from(seriesMap.values());
}

// 📺 XTREAM API (Dizileri Tek Kanal Mantığıyla Canlı Kanallara Çeviriyoruz)
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

    // DİZİLERİ TEK KANAL OLARAK "CANLI KATEGORİ" GÖSTERİYORUZ
    if (action === 'get_live_categories') {
        return res.json([
            { category_id: "999", category_name: "📺 Dizi Kanalları (Kesintisiz)", parent_id: 0 }
        ]);
    }

    // HER BİR DİZİ ARTIK CANLI KANAL LİSTESİNDE TEK BİR KANAL OLACAK
    if (action === 'get_live_streams') {
        const uniqueSeries = getAllUniqueSeries();
        let streams = [];

        uniqueSeries.forEach((series, index) => {
            // Canlı kanal ID'sini özel bir aralıkta veriyoruz (Örn: 9001, 9002...)
            const channelId = 9000 + index + 1;

            streams.push({
                num: streams.length + 1,
                name: `${series.name} (7/24 Kesintisiz)`,
                stream_id: channelId,
                stream_type: "live",
                stream_icon: series.logo || "",
                category_id: "999",
                direct_source: `http://${req.headers.host}/live/${USERNAME}/${PASSWORD}/${channelId}.ts`
            });
        });

        if (category_id) {
            streams = streams.filter(s => s.category_id === category_id.toString());
        }
        return res.json(streams);
    }

    // Normal VOD kısımlarını boş geçiyoruz ki TV tamamen Canlı Kanallara odaklansın
    if (action === 'get_vod_categories' || action === 'get_vod_streams' || action === 'get_series_categories' || action === 'get_series' || action === 'get_series_info') {
        return res.json([]);
    }

    res.json([]);
});

// 🎬 KESİNTİSİZ SIRALI AKIŞ MOTORU (Sıradaki Parçaya Otomatik Geçiş Yapan Proxy)
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    // ID temizleme (örn: 9001.ts veya 9001)
    const cleanIdMatch = id.match(/^(\d+)/);
    if (!cleanIdMatch) return res.status(400).send("Geçersiz Kanal ID");

    const channelId = parseInt(cleanIdMatch[1]);
    const uniqueSeries = getAllUniqueSeries();

    // Eğer istek dizi kanalından (9001 ve üzeri) geldiyse ilgili diziyi seç
    if (channelId >= 9001) {
        const seriesIndex = channelId - 9001;
        const targetSeries = uniqueSeries[seriesIndex];

        if (!targetSeries || targetSeries.items.length === 0) {
            return res.status(404).send("Dizi bulunamadı");
        }

        // Tüm parçaların URL listesi (Kuyruk)
        const playlistUrls = targetSeries.items.map(item => item.url);
        let currentIndex = 0;

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Connection', 'keep-alive');

        // Sıradaki parçayı oynatan özyinelemeli (recursive) akış fonksiyonu
        async function playNextStream() {
            if (currentIndex >= playlistUrls.length) {
                // Liste bittiğinde başa dönerek 7/24 döngü sağlar
                currentIndex = 0; 
            }

            const currentUrl = playlistUrls[currentIndex];
            currentIndex++;

            try {
                const response = await axios({
                    method: 'get',
                    url: currentUrl,
                    responseType: 'stream',
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });

                // Bu parça bittiğinde hiç duraksamadan hemen sıradakine geç
                response.data.on('end', () => {
                    playNextStream();
                });

                response.data.on('error', (err) => {
                    console.error("Parça akış hatası, sonrakine geçiliyor:", err.message);
                    playNextStream();
                });

                // Veriyi TV'ye aktar
                response.data.pipe(res, { end: false });

            } catch (err) {
                console.error("Bağlantı hatası, sonrakine geçiliyor:", err.message);
                playNextStream();
            }
        }

        // Akışı başlat
        playNextStream();
        return;
    }

    return res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Kesintisiz Dizi Kanalı Sunucusu ${PORT} portunda devrede.`));
