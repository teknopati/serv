const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200;

let cacheTV = [];
let cacheMovies = [];
let cacheSeries = [];

function loadAllPlaylists() {
    cacheTV = readM3UFile('tv.m3u');
    cacheMovies = readM3UFile('movie.m3u');
    cacheSeries = readM3UFile('series.m3u');
}

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

loadAllPlaylists();

// Series.m3u içindeki dizileri gruplayan orijinal motor
function getAllUniqueSeries() {
    const seriesMap = new Map();
    cacheSeries.forEach((item, index) => {
        const sKey = item.seriesName.toLowerCase();
        if (!seriesMap.has(sKey)) {
            seriesMap.set(sKey, {
                name: item.seriesName,
                logo: "",
                items: []
            });
        }
        item.globalIndex = index;
        seriesMap.get(sKey).items.push(item);
    });
    return Array.from(seriesMap.values());
}

// Series dizilerini Canlı TV içine kategori ve parça kanal olarak ekleyen motor
function getSeriesAsLiveChannels() {
    const uniqueSeries = getAllUniqueSeries();
    let categories = [];
    let streams = [];
    
    let catIdCounter = 5000;
    let streamIdCounter = 70000;

    uniqueSeries.forEach(series => {
        const currentCatId = catIdCounter.toString();
        categories.push({
            category_id: currentCatId,
            category_name: `📺 ${series.name}`,
            parent_id: 0
        });

        series.items.forEach((item) => {
            let displayName = item.name;
            if (!displayName.toLowerCase().includes("parça") && item.partNum > 0) {
                displayName = `${item.season}. Sezon ${item.episode}. Bölüm (Parça ${item.partNum})`;
            }

            streams.push({
                num: streams.length + 1,
                name: displayName,
                stream_id: streamIdCounter,
                stream_type: "live",
                stream_icon: "",
                category_id: currentCatId,
                direct_source: item.url
            });
            streamIdCounter++;
        });

        catIdCounter++;
    });

    return { categories, streams };
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

    // 1. CANLI KATEGORİLER (Normal TV Grupları + Dizi Kanalı Kategorileri)
    if (action === 'get_live_categories') {
        let categories = [];
        if (cacheTV.length > 0) {
            const cats = Array.from(new Set(cacheTV.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }

        // Dizi kategorilerini canlı TV'ye ekle
        const { categories: seriesCategories } = getSeriesAsLiveChannels();
        categories = categories.concat(seriesCategories);

        return res.json(categories);
    }

    // 2. CANLI KANALLAR (Normal TV Kanalları + Dizi Bölüm/Parça Kanalları)
    if (action === 'get_live_streams') {
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        let streams = [];

        cacheTV.forEach((item, index) => {
            const origCatId = (cats.indexOf(item.group) + 1).toString();
            streams.push({
                num: streams.length + 1,
                name: item.name,
                stream_id: index + 1,
                stream_type: "live",
                stream_icon: "",
                category_id: origCatId,
                direct_source: item.url
            });
        });

        // Dizi bölümlerini ve parçalarını canlı kanal olarak ekle
        const { streams: seriesStreams } = getSeriesAsLiveChannels();
        streams = streams.concat(seriesStreams);

        if (category_id) {
            streams = streams.filter(s => s.category_id === category_id.toString());
        }
        return res.json(streams);
    }

    // 3. VOD FİLMLER
    if (action === 'get_vod_categories') {
        if (cacheMovies.length === 0) return res.json([{ category_id: "1", category_name: "Film Yok", parent_id: 0 }]);
        const cats = Array.from(new Set(cacheMovies.map(i => i.group)));
        let categories = cats.map((c, i) => ({ category_id: (i + 1).toString(), category_name: c || "Filmler", parent_id: 0 }));
        return res.json(categories);
    }

    if (action === 'get_vod_streams') {
        const cats = Array.from(new Set(cacheMovies.map(i => i.group)));
        let vodList = cacheMovies.map((item, index) => ({
            num: index + 1,
            name: item.name,
            stream_id: index + 1001,
            stream_type: "movie",
            stream_icon: "",
            category_id: (cats.indexOf(item.group) + 1).toString(),
            container_extension: "mp4",
            rating: "8.0",
            added: "1600000000"
        }));

        if (category_id) {
            vodList = vodList.filter(v => v.category_id === category_id.toString());
        }
        return res.json(vodList);
    }

    // 4. DİZİLER (SERIES - Orijinal ve kusursuz haliyle bırakıldı)
    if (action === 'get_series_categories') {
        return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);
    }

    if (action === 'get_series') {
        const uniqueSeries = getAllUniqueSeries();
        let seriesList = uniqueSeries.map((data, index) => ({
            num: index + 1,
            name: data.name,
            series_id: index + 1,
            cover: "",
            plot: `${data.name} Dizisi`,
            genre: "Dizi / Çizgi Dizi",
            category_id: "1"
        }));
        return res.json(seriesList);
    }

    if (action === 'get_series_info') {
        const targetId = parseInt(series_id) || 1;
        const uniqueSeries = getAllUniqueSeries();
        const targetSeries = uniqueSeries[targetId - 1];

        if (!targetSeries) return res.json({ seasons: [], episodes: {} });

        let seasonsSet = new Set();
        let episodesObj = {};

        targetSeries.items.forEach((item, idx) => {
            const sNum = item.season || 1;
            seasonsSet.add(sNum);
            const seasonKey = sNum.toString();

            if (!episodesObj[seasonKey]) episodesObj[seasonKey] = [];

            const globalEpId = (targetId * 10000) + (idx + 1);

            let displayName = item.name;
            if (!displayName.toLowerCase().includes("parça") && item.partNum > 0) {
                displayName = `${sNum}. Sezon ${item.episode}. Bölüm (Parça ${item.partNum})`;
            }

            episodesObj[seasonKey].push({
                id: globalEpId.toString(),
                episode_num: idx + 1,
                title: displayName,
                container_extension: "mp4",
                info: { 
                    duration_secs: item.durationInSeconds,
                    duration: `${Math.round(item.durationInSeconds / 60)} min`,
                    plot: displayName, 
                    movie_image: "" 
                }
            });
        });

        const sortedSeasons = Array.from(seasonsSet).sort((a, b) => a - b);
        const seasonsList = sortedSeasons.map(s => ({
            id: s,
            name: `${s}. Sezon`,
            season_number: s,
            cover: ""
        }));

        return res.json({
            seasons: seasonsList,
            episodes: episodesObj,
            info: { name: targetSeries.name, cover: "" }
        });
    }

    res.json([]);
});

// 🎬 AKIŞ YÖNLENDİRİCİSİ
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const cleanIdMatch = id.match(/^(\d+)/);
    if (!cleanIdMatch) return res.status(400).send("Geçersiz Yayın ID");

    const cleanId = parseInt(cleanIdMatch[1]);
    const uniqueSeries = getAllUniqueSeries();
    const { streams: seriesStreams } = getSeriesAsLiveChannels();

    let targetUrl = null;

    if (cleanId <= 500 && cacheTV[cleanId - 1]) {
        targetUrl = cacheTV[cleanId - 1].url;
    } else if (cleanId > 1000 && cleanId < 2000 && cacheMovies[cleanId - 1001]) {
        targetUrl = cacheMovies[cleanId - 1001].url;
    } else if (cleanId >= 70000) {
        // Canlı TV içine eklenen dizi parçası kanalları
        const foundStream = seriesStreams.find(s => s.stream_id === cleanId);
        if (foundStream) targetUrl = foundStream.direct_source;
    } else if (cleanId >= 10001) {
        // Orijinal Series menüsünden gelenler
        const seriesIndex = Math.floor(cleanId / 10000) - 1;
        const itemIndex = (cleanId % 10000) - 1;
        const targetSeries = uniqueSeries[seriesIndex];

        if (targetSeries && targetSeries.items[itemIndex]) {
            targetUrl = targetSeries.items[itemIndex].url;
        }
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
