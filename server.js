const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

let cacheTV = [];
let cacheMovies = [];
let cacheSeries = [];
let seriesChannelMap = new Map();

// 🧠 Her kanalın hangi parçada kaldığını tutan hafıza
let channelIndices = {}; 

// 📺 En son aktif olarak izlenen kanal ve son istek zamanı
let currentWatchingChannel = null;
let lastRequestTime = 0;

function parseM3U(content) {
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
            if (partMatch) partNum = parseInt(partMatch[1]);

            currentItem = { 
                name: rawTitle, 
                group: rawGroup, 
                seriesName, 
                logo, 
                season, 
                episode, 
                partNum 
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
}

function initSeriesChannels() {
    seriesChannelMap.clear();
    cacheSeries.forEach(item => {
        const sKey = item.seriesName.toLowerCase();
        if (!seriesChannelMap.has(sKey)) {
            seriesChannelMap.set(sKey, {
                name: item.seriesName,
                logo: item.logo,
                items: []
            });
        }
        seriesChannelMap.get(sKey).items.push(item);
    });

    // Parçaları sırala (Sezon 1 Bölüm 1 Part 1 -> Part 2 ...)
    seriesChannelMap.forEach(dizi => {
        dizi.items.sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            if (a.episode !== b.episode) return a.episode - b.episode;
            return a.partNum - b.partNum;
        });
    });
}

function loadAllFiles() {
    try {
        const tvPath = path.join(__dirname, 'tv.m3u');
        if (fs.existsSync(tvPath)) cacheTV = parseM3U(fs.readFileSync(tvPath, 'utf-8'));

        const moviePath = path.join(__dirname, 'movie.m3u');
        if (fs.existsSync(moviePath)) cacheMovies = parseM3U(fs.readFileSync(moviePath, 'utf-8'));

        const seriesPath = path.join(__dirname, 'series.m3u');
        if (fs.existsSync(seriesPath)) {
            cacheSeries = parseM3U(fs.readFileSync(seriesPath, 'utf-8'));
            initSeriesChannels();
        }
    } catch (e) {
        console.error("M3U yükleme hatası:", e);
    }
}

loadAllFiles();

// 📺 XTREAM API
app.get('/player_api.php', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
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

    // 1. CANLI KATEGORİLER
    if (action === 'get_live_categories') {
        let categories = [{ category_id: "724_diziler", category_name: "📺 7/24 DİZİLER", parent_id: 0 }];
        if (cacheTV.length > 0) {
            const cats = Array.from(new Set(cacheTV.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }
        return res.json(categories);
    }

    // 2. CANLI KANALLAR
    if (action === 'get_live_streams') {
        let streams = [];
        const seriesList = Array.from(seriesChannelMap.values());
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));

        seriesList.forEach((s, idx) => {
            streams.push({
                num: streams.length + 1,
                name: `📺 7/24 ${s.name.toUpperCase()}`,
                stream_id: 501 + idx,
                stream_type: "live",
                stream_icon: s.logo,
                category_id: "724_diziler",
                direct_source: ""
            });
        });

        cacheTV.forEach((item, index) => {
            streams.push({
                num: streams.length + 1,
                name: item.name,
                stream_id: index + 1,
                stream_type: "live",
                stream_icon: item.logo,
                category_id: (cats.indexOf(item.group) + 1).toString(),
                direct_source: item.url
            });
        });

        if (category_id) {
            streams = streams.filter(s => s.category_id === category_id.toString());
        }
        return res.json(streams);
    }

    // 3. VOD FİLMLER
    if (action === 'get_vod_categories') {
        if (cacheMovies.length === 0) return res.json([{ category_id: "1", category_name: "Film Yok", parent_id: 0 }]);
        const cats = Array.from(new Set(cacheMovies.map(i => i.group)));
        return res.json(cats.map((c, i) => ({ category_id: (i + 1).toString(), category_name: c || "Filmler", parent_id: 0 })));
    }

    if (action === 'get_vod_streams') {
        const cats = Array.from(new Set(cacheMovies.map(i => i.group)));
        let vodList = cacheMovies.map((item, index) => ({
            num: index + 1,
            name: item.name,
            stream_id: index + 1001,
            stream_type: "movie",
            stream_icon: item.logo || "",
            category_id: (cats.indexOf(item.group) + 1).toString(),
            container_extension: "mp4",
            rating: "8.0",
            added: "1600000000"
        }));

        if (category_id) vodList = vodList.filter(v => v.category_id === category_id.toString());
        return res.json(vodList);
    }

    // 4. DİZİLER MENÜSÜ
    if (action === 'get_series_categories') {
        return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);
    }

    if (action === 'get_series') {
        const seriesList = Array.from(seriesChannelMap.values());
        return res.json(seriesList.map((s, index) => ({
            num: index + 1,
            name: s.name,
            series_id: index + 1,
            cover: s.logo,
            plot: `${s.name} Tüm Bölümler`,
            genre: "Dizi",
            category_id: "1"
        })));
    }

    res.json([]);
});

// 🎬 AKILLI KANAL AYRIŞTIRICI VE OYNATICI
app.get('/:type/:user/:pass/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const cleanIdMatch = id.match(/^(\d+)/);
    if (!cleanIdMatch) return res.status(400).send("Geçersiz Yayın ID");

    const cleanId = parseInt(cleanIdMatch[1]);
    const seriesList = Array.from(seriesChannelMap.values());
    const now = Date.now();

    // 1. 7/24 DİZİ KANALLARI (501 - 599)
    if (cleanId >= 501 && cleanId <= 599) {
        const seriesIdx = cleanId - 501;
        const targetSeries = seriesList[seriesIdx];
        
        if (targetSeries && targetSeries.items.length > 0) {
            const items = targetSeries.items;

            if (channelIndices[cleanId] === undefined) {
                channelIndices[cleanId] = 0;
            } else {
                // KONTROL 1: Kullanıcı bu kanalı hiç değiştirmeden izlemeye devam ediyor mu?
                if (currentWatchingChannel === cleanId) {
                    const elapsed = now - lastRequestTime;
                    // TV oynatıcıları ilk bağlantıda çift istek atar (0-3 sn arası atlama yapılmaz).
                    // 3 saniyeden sonra aynı kanaldan istek geldiyse: Video bitmiştir veya ileri sarılmıştır!
                    if (elapsed > 3000) {
                        channelIndices[cleanId] = (channelIndices[cleanId] + 1) % items.length;
                    }
                } 
                // KONTROL 2: Başka bir kanaldan bu kanala yeni geçildiyse (currentWatchingChannel !== cleanId):
                // channelIndices[cleanId] kesinlikle artırılmaz! Kaldığı parça en baştan verilir.
            }

            // O anki aktif kanalı ve istek zamanını güncelle
            currentWatchingChannel = cleanId;
            lastRequestTime = now;

            const currentIdx = channelIndices[cleanId];
            const activeVideo = items[currentIdx];
            
            console.log(`[7/24 ${targetSeries.name}] Oynatılıyor (${currentIdx + 1}/${items.length}): ${activeVideo.name}`);
            
            return res.redirect(302, `${activeVideo.url}&_t=${now}`);
        }
    }

    // 2. NORMAL CANLI TV (1 - 500)
    if (cleanId <= 500 && cacheTV[cleanId - 1]) {
        currentWatchingChannel = cleanId;
        lastRequestTime = now;
        return res.redirect(302, cacheTV[cleanId - 1].url);
    }

    // 3. FİLMLER (1001 - 1999)
    if (cleanId > 1000 && cleanId < 2000 && cacheMovies[cleanId - 1001]) {
        currentWatchingChannel = cleanId;
        lastRequestTime = now;
        return res.redirect(302, cacheMovies[cleanId - 1001].url);
    }

    return res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`7/24 Kesintisiz Kanal Takip Sunucusu ${PORT} portunda devrede.`));
