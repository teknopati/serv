const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200;

// Önbellek (I/O gecikmesini ve donmayı önler)
let cacheTV = [];
let cacheMovies = [];
let cacheSeries = [];

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

function loadAllFiles() {
    try {
        const tvPath = path.join(__dirname, 'tv.m3u');
        if (fs.existsSync(tvPath)) cacheTV = parseM3U(fs.readFileSync(tvPath, 'utf-8'));

        const moviePath = path.join(__dirname, 'movie.m3u');
        if (fs.existsSync(moviePath)) cacheMovies = parseM3U(fs.readFileSync(moviePath, 'utf-8'));

        const seriesPath = path.join(__dirname, 'series.m3u');
        if (fs.existsSync(seriesPath)) cacheSeries = parseM3U(fs.readFileSync(seriesPath, 'utf-8'));
    } catch (e) {
        console.error("M3U yükleme hatası:", e);
    }
}

loadAllFiles();

function getGroupedSeriesList() {
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

    return seriesMap;
}

function getAllUniqueSeries() {
    return Array.from(getGroupedSeriesList().values());
}

function getLiveHlsManifest(seriesName) {
    const rawItems = cacheSeries.filter(i => i.seriesName.toLowerCase() === seriesName.toLowerCase());
    if (rawItems.length === 0) return null;

    const totalDuration = rawItems.length * DEFAULT_EP_DURATION;
    const nowSec = Math.floor(Date.now() / 1000);
    const loopOffset = nowSec % totalDuration;

    const currentPartIdx = Math.floor(loopOffset / DEFAULT_EP_DURATION);
    const mediaSequence = Math.floor(nowSec / DEFAULT_EP_DURATION);

    let m3u8 = `#EXTM3U\n`;
    m3u8 += `#EXT-X-VERSION:3\n`;
    m3u8 += `#EXT-X-TARGETDURATION:${DEFAULT_EP_DURATION + 10}\n`;
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`;

    for (let i = 0; i < 3; i++) {
        const idx = (currentPartIdx + i) % rawItems.length;
        const item = rawItems[idx];
        if (i > 0) m3u8 += `#EXT-X-DISCONTINUITY\n`;
        m3u8 += `#EXTINF:${DEFAULT_EP_DURATION}.0, ${item.name}\n`;
        m3u8 += `${item.url}\n`;
    }

    return m3u8;
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

    // CANLI KATEGORİLER
    if (action === 'get_live_categories') {
        let categories = [{ category_id: "724_diziler", category_name: "📺 7/24 DİZİLER", parent_id: 0 }];
        if (cacheTV.length > 0) {
            const cats = Array.from(new Set(cacheTV.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }
        return res.json(categories);
    }

    // CANLI KANALLAR
    if (action === 'get_live_streams') {
        const uniqueSeries = getAllUniqueSeries();
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        let streams = [];

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

    // VOD FİLMLER
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

    // DİZİLER
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
                    container_extension: "m3u8",
                    info: { 
                        duration: `${epData.parts.length * 20} min`, 
                        plot: `${epData.parts.length} Parçadan Oluşan Tam Bölüm`, 
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

// 🎬 YAYIN KÖPRÜSÜ
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const cleanIdMatch = id.match(/^(\d+)/);
    if (!cleanIdMatch) return res.status(400).send("Geçersiz Yayın ID");

    const cleanId = parseInt(cleanIdMatch[1]);
    const uniqueSeries = getAllUniqueSeries();

    // 1. 7/24 Dizi Kanalları (501 - 599)
    if (cleanId >= 501 && cleanId <= 599) {
        const seriesIdx = cleanId - 501;
        const targetSeries = uniqueSeries[seriesIdx];
        if (targetSeries) {
            const manifest = getLiveHlsManifest(targetSeries.name);
            if (manifest) {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                return res.send(manifest);
            }
        }
    }

    // 2. Normal Canlı TV (1 - 500)
    if (cleanId <= 500 && cacheTV[cleanId - 1]) {
        return res.redirect(302, cacheTV[cleanId - 1].url);
    }
    
    // 3. Filmler (1001 - 1999)
    if (cleanId > 1000 && cleanId < 2000 && cacheMovies[cleanId - 1001]) {
        return res.redirect(302, cacheMovies[cleanId - 1001].url);
    }
    
    // 4. Dizi Bölümü (100000+)
    if (cleanId >= 100000) {
        const seriesIdx = Math.floor(cleanId / 100000) - 1;
        const remainder = cleanId % 100000;
        const seasonNum = Math.floor(remainder / 1000);
        const epNum = remainder % 1000;

        const targetSeries = uniqueSeries[seriesIdx];
        if (targetSeries && targetSeries.seasons[seasonNum] && targetSeries.seasons[seasonNum][epNum]) {
            const epData = targetSeries.seasons[seasonNum][epNum];

            let vodM3u8 = `#EXTM3U\n`;
            vodM3u8 += `#EXT-X-VERSION:3\n`;
            vodM3u8 += `#EXT-X-TARGETDURATION:${DEFAULT_EP_DURATION + 10}\n`;
            vodM3u8 += `#EXT-X-PLAYLIST-TYPE:VOD\n`;

            epData.parts.forEach((part, i) => {
                if (i > 0) vodM3u8 += `#EXT-X-DISCONTINUITY\n`;
                vodM3u8 += `#EXTINF:${part.durationInSeconds || DEFAULT_EP_DURATION}.0, ${part.name}\n`;
                vodM3u8 += `${part.url}\n`;
            });

            vodM3u8 += `#EXT-X-ENDLIST\n`;

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(vodM3u8);
        }
    }

    return res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Xtream IPTV Sunucusu ${PORT} portunda devrede.`));
