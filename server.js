const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200;

let cacheTV = [];
let cacheMovies = [];
let cacheSeries = [];
let groupedSeriesCache = new Map();

function parseM3U(content) {
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

            const tvgNameMatch = line.match(/tvg-name="([^"]+)"/);
            let episode = 1;
            if (tvgNameMatch) {
                const epMatch = tvgNameMatch[1].match(/E(\d+)/i);
                if (epMatch) episode = parseInt(epMatch[1]);
                const seMatch = tvgNameMatch[1].match(/S(\d+)/i);
                if (seMatch) season = parseInt(seMatch[1]);
            }

            const titleParts = line.split(',');
            const rawTitle = titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : `${episode}. Bölüm`;

            const epCleanMatch = rawTitle.match(/(?:(?:Bölüm\s*|S\d+E|\b)(\d+))|(?:(\d+)-(\d+))/i);
            if (epCleanMatch) {
                if (epCleanMatch[1]) episode = parseInt(epCleanMatch[1]);
                else if (epCleanMatch[3]) {
                    season = parseInt(epCleanMatch[2]);
                    episode = parseInt(epCleanMatch[3]);
                }
            }

            let partNum = 1;
            const partMatch = rawTitle.match(/(?:_P|\(Parça\s*|Parça\s*)(\d+)/i);
            if (partMatch) partNum = parseInt(partMatch[1]);

            let durationInSeconds = parsedDuration > 0 ? parsedDuration : DEFAULT_EP_DURATION;

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
}

function rebuildSeriesHierarchy() {
    const seriesMap = new Map();

    cacheSeries.forEach(item => {
        const sKey = item.seriesName.toLowerCase();
        if (!seriesMap.has(sKey)) {
            seriesMap.set(sKey, {
                name: item.seriesName,
                logo: item.logo,
                seasons: {}
            });
        }

        const seriesObj = seriesMap.get(sKey);
        const seasonNum = item.season || 1;
        const episodeNum = item.episode || 1;

        if (!seriesObj.seasons[seasonNum]) {
            seriesObj.seasons[seasonNum] = {};
        }

        if (!seriesObj.seasons[seasonNum][episodeNum]) {
            seriesObj.seasons[seasonNum][episodeNum] = {
                season: seasonNum,
                episode: episodeNum,
                title: `${seasonNum}. Sezon ${episodeNum}. Bölüm`,
                logo: item.logo,
                parts: []
            };
        }

        seriesObj.seasons[seasonNum][episodeNum].parts.push(item);
    });

    seriesMap.forEach(s => {
        Object.keys(s.seasons).forEach(sn => {
            Object.keys(s.seasons[sn]).forEach(en => {
                s.seasons[sn][en].parts.sort((a, b) => a.partNum - b.partNum);
            });
        });
    });

    groupedSeriesCache = seriesMap;
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
            rebuildSeriesHierarchy();
        }
    } catch (e) {
        console.error("M3U yükleme hatası:", e);
    }
}

loadAllFiles();

function getAllUniqueSeries() {
    return Array.from(groupedSeriesCache.values());
}

// 📺 XTREAM API
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
        const uniqueSeries = getAllUniqueSeries();
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        let streams = [];

        // 7/24 Dizi Kanalları (Stream ID: 501 - 599)
        uniqueSeries.forEach((s, idx) => {
            streams.push({
                num: streams.length + 1,
                name: `7/24 ${s.name.toUpperCase()}`,
                stream_id: 501 + idx,
                stream_type: "live",
                stream_icon: s.logo,
                category_id: "724_diziler",
                direct_source: ""
            });
        });

        // Standart TV Kanalları (Stream ID: 1 - 500)
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

    // 4. DİZİLER
    if (action === 'get_series_categories') {
        return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);
    }

    if (action === 'get_series') {
        const uniqueSeries = getAllUniqueSeries();
        return res.json(uniqueSeries.map((data, index) => ({
            num: index + 1,
            name: data.name,
            series_id: index + 1,
            cover: data.logo,
            plot: `${data.name} Dizisi`,
            genre: "Dizi / Çizgi Dizi",
            category_id: "1"
        })));
    }

    if (action === 'get_series_info') {
        const targetId = parseInt(series_id) || 1;
        const uniqueSeries = getAllUniqueSeries();
        const targetSeries = uniqueSeries[targetId - 1];

        if (!targetSeries) return res.json({ seasons: [], episodes: {} });

        let seasonsList = [];
        let episodesObj = {};

        Object.keys(targetSeries.seasons).forEach(seasonNum => {
            const sInt = parseInt(seasonNum);
            seasonsList.push({
                id: sInt,
                name: `${sInt}. Sezon`,
                season_number: sInt,
                cover: targetSeries.logo
            });

            episodesObj[seasonNum] = [];
            const epKeys = Object.keys(targetSeries.seasons[seasonNum]).sort((a, b) => parseInt(a) - parseInt(b));

            epKeys.forEach(epNum => {
                const epData = targetSeries.seasons[seasonNum][epNum];
                const globalEpId = (targetId * 100000) + (sInt * 1000) + parseInt(epNum);
                
                episodesObj[seasonNum].push({
                    id: globalEpId.toString(),
                    episode_num: parseInt(epNum),
                    title: `${targetSeries.name} - ${sInt}. Sezon ${epNum}. Bölüm`,
                    container_extension: "mp4",
                    info: { 
                        duration_secs: epData.parts.reduce((acc, p) => acc + (p.durationInSeconds || DEFAULT_EP_DURATION), 0),
                        duration: `${epData.parts.length * 20} min`, 
                        plot: `${epData.parts.length} Parçadan Oluşan Bölüm`, 
                        movie_image: epData.logo || targetSeries.logo 
                    }
                });
            });
        });

        seasonsList.sort((a, b) => a.season_number - b.season_number);

        return res.json({
            seasons: seasonsList,
            episodes: episodesObj,
            info: { name: targetSeries.name, cover: targetSeries.logo }
        });
    }

    res.json([]);
});

// 🎬 STREAM VE YÖNLENDİRİCİ
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const cleanIdMatch = id.match(/^(\d+)/);
    if (!cleanIdMatch) return res.status(400).send("Geçersiz Yayın ID");

    const cleanId = parseInt(cleanIdMatch[1]);
    const uniqueSeries = getAllUniqueSeries();

    // 1. 7/24 Dizi Canlı Akışı (Günün Saatine Göre Sıradaki Parça)
    if (cleanId >= 501 && cleanId <= 599) {
        const seriesIdx = cleanId - 501;
        const targetSeries = uniqueSeries[seriesIdx];
        if (targetSeries) {
            const rawItems = cacheSeries.filter(i => i.seriesName.toLowerCase() === targetSeries.name.toLowerCase());
            if (rawItems.length > 0) {
                const totalDuration = rawItems.length * DEFAULT_EP_DURATION;
                const nowSec = Math.floor(Date.now() / 1000);
                const currentPartIdx = Math.floor((nowSec % totalDuration) / DEFAULT_EP_DURATION);
                const activeItem = rawItems[currentPartIdx % rawItems.length];
                return res.redirect(302, activeItem.url);
            }
        }
    }

    // 2. Normal Canlı TV Kanalları (1 - 500)
    if (cleanId <= 500 && cacheTV[cleanId - 1]) {
        return res.redirect(302, cacheTV[cleanId - 1].url);
    }
    
    // 3. Filmler (1001 - 1999)
    if (cleanId > 1000 && cleanId < 2000 && cacheMovies[cleanId - 1001]) {
        return res.redirect(302, cacheMovies[cleanId - 1001].url);
    }
    
    // 4. Dizi Bölümleri (100000+)
    if (cleanId >= 100000) {
        const seriesIdx = Math.floor(cleanId / 100000) - 1;
        const remainder = cleanId % 100000;
        const seasonNum = Math.floor(remainder / 1000);
        const epNum = remainder % 1000;

        const targetSeries = uniqueSeries[seriesIdx];
        if (targetSeries && targetSeries.seasons[seasonNum] && targetSeries.seasons[seasonNum][epNum]) {
            const epData = targetSeries.seasons[seasonNum][epNum];
            if (epData.parts.length > 0) {
                return res.redirect(302, epData.parts[0].url);
            }
        }
    }

    return res.status(404).send("Yayın bulunamadı");
});

// 📦 DOĞRUDAN M3U / USB LİSTESİ ÇIKTISI
app.get('/playlist/all.m3u', (req, res) => {
    let m3u = "#EXTM3U\n";

    // 7/24 Dizi Kanalları
    const uniqueSeries = getAllUniqueSeries();
    uniqueSeries.forEach((s, idx) => {
        m3u += `#EXTINF:-1 group-title="7/24 DİZİLER",📺 7/24 ${s.name.toUpperCase()}\n`;
        m3u += `http://${req.headers.host}/live/${USERNAME}/${PASSWORD}/${501 + idx}.ts\n`;
    });

    // Canlı TV
    cacheTV.forEach(item => {
        const logo = item.logo ? ` tvg-logo="${item.logo}"` : '';
        const group = item.group ? ` group-title="${item.group}"` : '';
        m3u += `#EXTINF:-1${logo}${group},${item.name}\n${item.url}\n`;
    });

    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    return res.send(m3u);
});

app.listen(PORT, () => console.log(`Optimize Xtream & M3U Sunucusu ${PORT} portunda devrede.`));
