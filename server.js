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

// 📺 XTRAY API
app.get('/player_api.php', (req, res) => {
    const { username, password, action, series_id, category_id } = req.query;

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

    // CANLI KATEGORİLER
    if (action === 'get_live_categories') {
        const liveItems = readM3UFile('tv.m3u');
        let categories = [];
        if (liveItems.length > 0) {
            const cats = Array.from(new Set(liveItems.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }
        
        // Dizi Kanalları İçin Özel Kategori
        categories.push({ category_id: "999", category_name: "📺 Dizi Kanalları", parent_id: 0 });

        ALPHABET_GROUPS.forEach(group => {
            categories.push({ category_id: group.id, category_name: group.name, parent_id: 0 });
        });
        return res.json(categories);
    }

    // CANLI KANALLAR (Normal Kanallar + Her Dizi İçin Özel Kanal)
    if (action === 'get_live_streams') {
        const liveItems = readM3UFile('tv.m3u');
        const uniqueSeries = getAllUniqueSeries();
        const cats = Array.from(new Set(liveItems.map(i => i.group)));
        let streams = [];

        // 1. Normal Canlı Kanallar
        liveItems.forEach((item, index) => {
            const origCatId = (cats.indexOf(item.group) + 1).toString();
            const alphaCatId = getAlphabetCategoryId(item.name);
            const streamId = index + 1;

            let targetCatId = origCatId;
            if (category_id && category_id.toString().startsWith("alpha_")) {
                targetCatId = alphaCatId;
            }

            streams.push({
                num: streams.length + 1,
                name: item.name,
                stream_id: streamId,
                stream_type: "live",
                stream_icon: item.logo,
                category_id: targetCatId,
                direct_source: item.url
            });
        });

        // 2. Her Diziyi Ayrı Bir "Canlı Kanal" Olarak Ekliyoruz (ID: 9001, 9002...)
        uniqueSeries.forEach((series, index) => {
            const channelId = 9001 + index;
            streams.push({
                num: streams.length + 1,
                name: `${series.name} (Kanal)`,
                stream_id: channelId,
                stream_type: "live",
                stream_icon: series.logo || "",
                category_id: "999",
                direct_source: `http://${req.headers.host}/series_channel/${USERNAME}/${PASSWORD}/${index}`
            });
        });

        if (category_id) {
            streams = streams.filter(s => s.category_id === category_id.toString());
        }
        return res.json(streams);
    }

    // VOD FİLMLER
    if (action === 'get_vod_categories') {
        const movieItems = readM3UFile('movie.m3u');
        if (movieItems.length === 0) return res.json([{ category_id: "1", category_name: "Film Yok", parent_id: 0 }]);
        const cats = Array.from(new Set(movieItems.map(i => i.group)));
        let categories = cats.map((c, i) => ({ category_id: (i + 1).toString(), category_name: c || "Filmler", parent_id: 0 }));
        return res.json(categories);
    }

    if (action === 'get_vod_streams') {
        const movieItems = readM3UFile('movie.m3u');
        const cats = Array.from(new Set(movieItems.map(i => i.group)));
        let vodList = movieItems.map((item, index) => ({
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

    // DİZİLER (Series - Artık canlı kanal oldukları için boş dönebilir)
    if (action === 'get_series_categories' || action === 'get_series' || action === 'get_series_info') {
        return res.json([]);
    }

    res.json([]);
});

// 🎬 DİZİ KANALI AKIŞ MOTORU (Kanal açıldığında parçalar sırayla oynar)
app.get('/series_channel/:user/:pass/:seriesIndex', async (req, res) => {
    const { user, pass, seriesIndex } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const uniqueSeries = getAllUniqueSeries();
    const targetSeries = uniqueSeries[parseInt(seriesIndex)];

    if (!targetSeries || targetSeries.items.length === 0) {
        return res.status(404).send("Dizi bulunamadı");
    }

    const playlistUrls = targetSeries.items.map(item => item.url);
    let currentIndex = 0;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Connection', 'keep-alive');

    async function playNext() {
        if (currentIndex >= playlistUrls.length) {
            currentIndex = 0; // Liste bitince başa sarar
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

            response.data.on('end', () => {
                playNext();
            });

            response.data.on('error', () => {
                playNext();
            });

            response.data.pipe(res, { end: false });
        } catch (err) {
            playNext();
        }
    }

    playNext();
});

// 🎬 NORMAL CANLI KANALLAR VE FİLMLER İÇİN YÖNLENDİRİCİ
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const cleanIdMatch = id.match(/^(\d+)/);
    if (!cleanIdMatch) return res.status(400).send("Geçersiz Yayın ID");

    const cleanId = parseInt(cleanIdMatch[1]);
    const tvItems = readM3UFile('tv.m3u');
    const movieItems = readM3UFile('movie.m3u');

    let targetUrl = null;

    if (cleanId <= 500 && tvItems[cleanId - 1]) {
        targetUrl = tvItems[cleanId - 1].url;
    } else if (cleanId > 1000 && cleanId < 2000 && movieItems[cleanId - 1001]) {
        targetUrl = movieItems[cleanId - 1001].url;
    }

    if (!targetUrl) {
        return res.status(404).send("Yayın bulunamadı");
    }

    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        res.setHeader('Content-Type', 'video/mp4');
        response.data.pipe(res);
    } catch (err) {
        return res.redirect(302, targetUrl);
    }
});

app.listen(PORT, () => console.log(`Xtream IPTV Sunucusu ${PORT} portunda devrede.`));
