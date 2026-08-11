const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

// 📝 M3U Okuyucu (HTTP, HTTPS, SMB, FILE ve Süre Destekli)
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
                // Saniye cinsinden süre bilgisini al (#EXTINF:660)
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
                const name = titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : `${episode}. Bölüm`;

                // Bölüm bazlı dinamik süre tespiti
                let durationInSeconds = 11 * 60; // Varsayılan 11 dk
                if (parsedDuration > 0) {
                    durationInSeconds = parsedDuration;
                } else {
                    const nameLower = name.toLowerCase();
                    if (nameLower.includes("özel") || nameLower.includes("noel") || nameLower.includes("part") || nameLower.includes("bölüm 1") || nameLower.includes("movie")) {
                        durationInSeconds = 22 * 60; // Çift/Özel bölüm: 22 dk
                    }
                }

                currentItem = { name, group: rawGroup, seriesName, logo, season, episode, durationInSeconds };
            } else if (
                line.startsWith('http://') || 
                line.startsWith('https://') || 
                line.startsWith('smb://') || 
                line.startsWith('file://')
            ) {
                if (currentItem.name) {
                    currentItem.url = line;
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

// 🕒 OTOMATİK 7/24 YAYIN MOTORU (Tüm Diziler İçin)
function getSeriesLiveState(seriesNameTarget) {
    const allSeries = readM3UFile('series.m3u');
    
    // İstenen diziye ait tüm bölümleri filtrele
    const seriesEpisodes = allSeries.filter(item => 
        item.seriesName.toLowerCase() === seriesNameTarget.toLowerCase()
    );

    if (seriesEpisodes.length === 0) return null;

    // Toplam yayın döngü süresi
    const totalDuration = seriesEpisodes.reduce((acc, ep) => acc + ep.durationInSeconds, 0);
    
    const nowInSeconds = Math.floor(Date.now() / 1000);
    let currentLoopPos = nowInSeconds % totalDuration;

    let accumulatedTime = 0;
    let currentEpisode = seriesEpisodes[0];
    let currentIndex = 0;

    for (let i = 0; i < seriesEpisodes.length; i++) {
        accumulatedTime += seriesEpisodes[i].durationInSeconds;
        if (currentLoopPos < accumulatedTime) {
            currentEpisode = seriesEpisodes[i];
            currentIndex = i;
            break;
        }
    }

    return {
        episode: currentEpisode,
        currentIndex: currentIndex,
        totalEpisodes: seriesEpisodes.length
    };
}

// 📺 Sistemdeki Tüm Dizileri Gruplayan Yardımcı Fonksiyon
function getAllUniqueSeries() {
    const seriesItems = readM3UFile('series.m3u');
    let seriesMap = new Map();

    seriesItems.forEach(item => {
        if (!seriesMap.has(item.seriesName)) {
            seriesMap.set(item.seriesName, {
                name: item.seriesName,
                logo: item.logo
            });
        }
    });

    return Array.from(seriesMap.values());
}

app.get('/player_api.php', (req, res) => {
    const { username, password, action, series_id } = req.query;

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

    // --- 1. CANLI TV MENÜSÜ ---
    if (action === 'get_live_categories') {
        const liveItems = readM3UFile('tv.m3u');
        let categories = [{ category_id: "724", category_name: "7/24 Canlı Diziler", parent_id: 0 }];
        
        if (liveItems.length > 0) {
            const cats = Array.from(new Set(liveItems.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }
        return res.json(categories);
    }

    if (action === 'get_live_streams') {
        const liveItems = readM3UFile('tv.m3u');
        const cats = Array.from(new Set(liveItems.map(i => i.group)));
        const uniqueSeries = getAllUniqueSeries();
        
        let streams = [];

        // 🌟 OTOMATİK 7/24 KANAL OLUŞTURUCU (series.m3u içindeki HER dizi için 1 kanal açar)
        uniqueSeries.forEach((series, index) => {
            const liveState = getSeriesLiveState(series.name);
            const streamId = 9000 + index; // 7/24 Kanalları için özel ID serisi

            streams.push({
                num: index + 1,
                name: (liveState && liveState.episode) ? `${series.name} 7/24 TV (${liveState.episode.name})` : `${series.name} (7/24 TV)`,
                stream_id: streamId,
                stream_type: "live",
                stream_icon: series.logo || "https://image.tmdb.org/t/p/w1280/7MnzSQ7YV29EeqXFuGXpClfcRCc.jpg",
                category_id: "724",
                direct_source: ""
            });
        });

        // tv.m3u içindeki harici canlı TV kanalları
        liveItems.forEach((item, index) => {
            streams.push({
                num: uniqueSeries.length + index + 1,
                name: item.name,
                stream_id: index + 1,
                stream_type: "live",
                stream_icon: item.logo,
                category_id: (cats.indexOf(item.group) + 1).toString(),
                direct_source: item.url
            });
        });

        return res.json(streams);
    }

    // --- 2. MOVIE MENÜSÜ ---
    if (action === 'get_vod_categories') return res.json([{ category_id: "1", category_name: "Film Yok", parent_id: 0 }]);
    if (action === 'get_vod_streams') return res.json([]);

    // --- 3. SERIES (VOD DİZİ) MENÜSÜ ---
    if (action === 'get_series_categories') {
        const seriesItems = readM3UFile('series.m3u');
        if (seriesItems.length === 0) return res.json([{ category_id: "1", category_name: "Dizi Yok", parent_id: 0 }]);
        return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);
    }

    if (action === 'get_series') {
        const uniqueSeries = getAllUniqueSeries();
        let seriesList = [];

        uniqueSeries.forEach((data, index) => {
            seriesList.push({
                num: index + 1,
                name: data.name,
                series_id: index + 1,
                cover: data.logo,
                plot: `${data.name} Dizisi`,
                genre: "Dizi / Çizgi Dizi",
                category_id: "1"
            });
        });

        return res.json(seriesList);
    }

    if (action === 'get_series_info') {
        const seriesItems = readM3UFile('series.m3u');
        const targetId = parseInt(series_id) || 1;
        const uniqueSeries = getAllUniqueSeries();

        const targetSeries = uniqueSeries[targetId - 1];
        if (!targetSeries) return res.json({ seasons: [], episodes: {} });

        const targetEpisodes = seriesItems.filter(item => item.seriesName.toLowerCase() === targetSeries.name.toLowerCase());

        let seasonsSet = new Set();
        let episodesObj = {};

        targetEpisodes.forEach((ep, index) => {
            seasonsSet.add(ep.season);
            const seasonKey = ep.season.toString();

            if (!episodesObj[seasonKey]) episodesObj[seasonKey] = [];

            let ext = "mp4";
            if (ep.url && ep.url.toLowerCase().endsWith('.mkv')) ext = "mkv";
            if (ep.url && ep.url.toLowerCase().endsWith('.m3u8')) ext = "m3u8";

            episodesObj[seasonKey].push({
                id: (index + 2000).toString(),
                episode_num: ep.episode,
                title: ep.name,
                container_extension: ext,
                info: { duration: `${Math.round(ep.durationInSeconds / 60)} min`, plot: ep.name, movie_image: ep.logo || targetSeries.logo }
            });
        });

        const sortedSeasons = Array.from(seasonsSet).sort((a, b) => a - b);
        const seasonsList = sortedSeasons.map(s => ({
            id: s,
            name: `${s}. Sezon`,
            season_number: s,
            cover: targetSeries.logo
        }));

        return res.json({
            seasons: seasonsList,
            episodes: episodesObj,
            info: { name: targetSeries.name, cover: targetSeries.logo }
        });
    }

    res.json([]);
});

// 🎬 OYNATMA İSTEKLERİ VE 7/24 YÖNLENDİRİCİ
app.get('/:type/:user/:pass/:id', (req, res) => {
    const { user, pass, id } = req.params;
    if (user !== USERNAME || pass !== PASSWORD) return res.status(403).send("Yetkisiz Erişim");

    const cleanId = parseInt(id.replace(/\.[^/.]+$/, ""));

    // 7/24 CANLI YAYIN KANALLARI İSTEĞİ (ID'ler 9000 ve üstü)
    if (cleanId >= 9000) {
        const seriesIndex = cleanId - 9000;
        const uniqueSeries = getAllUniqueSeries();
        const targetSeries = uniqueSeries[seriesIndex];

        if (targetSeries) {
            const liveState = getSeriesLiveState(targetSeries.name);
            if (liveState && liveState.episode && liveState.episode.url) {
                return res.redirect(302, liveState.episode.url);
            }
        }
    }

    const tvItems = readM3UFile('tv.m3u');
    const movieItems = readM3UFile('movie.m3u');
    const seriesItems = readM3UFile('series.m3u');

    if (cleanId <= 900 && tvItems[cleanId - 1]) return res.redirect(302, tvItems[cleanId - 1].url);
    if (cleanId > 1000 && cleanId < 2000 && movieItems[cleanId - 1001]) return res.redirect(302, movieItems[cleanId - 1001].url);
    if (cleanId >= 2000 && cleanId < 9000 && seriesItems[cleanId - 2000]) return res.redirect(302, seriesItems[cleanId - 2000].url);

    res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));
