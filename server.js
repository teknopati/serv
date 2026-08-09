const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

// Genel M3U Okuyucu Fonksiyon
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

                currentItem = { name, group: rawGroup, seriesName, logo, season, episode };
            } else if (line.startsWith('http://') || line.startsWith('https://')) {
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

    // EPG Isteklerini Kapat (Donmayı önler)
    if (action === 'get_epg' || action === 'get_short_epg' || action === 'get_simple_data_table') {
        return res.json({ epg_listings: [] });
    }

    // --- 1. TV / CANLI YAYIN (tv.m3u) ---
    if (action === 'get_live_categories') {
        const liveItems = readM3UFile('tv.m3u');
        if (liveItems.length === 0) return res.json([{ category_id: "1", category_name: "TV Yayını Yok", parent_id: 0 }]);
        const cats = Array.from(new Set(liveItems.map(i => i.group)));
        return res.json(cats.map((c, i) => ({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 })));
    }

    if (action === 'get_live_streams') {
        const liveItems = readM3UFile('tv.m3u');
        const cats = Array.from(new Set(liveItems.map(i => i.group)));
        return res.json(liveItems.map((item, index) => ({
            num: index + 1,
            name: item.name,
            stream_id: index + 1,
            stream_type: "live",
            stream_icon: item.logo,
            category_id: (cats.indexOf(item.group) + 1).toString(),
            direct_source: item.url
        })));
    }

    // --- 2. MOVIE / FILMLER (movie.m3u) ---
    if (action === 'get_vod_categories') {
        const movieItems = readM3UFile('movie.m3u');
        if (movieItems.length === 0) return res.json([{ category_id: "1", category_name: "Film Yok", parent_id: 0 }]);
        const cats = Array.from(new Set(movieItems.map(i => i.group)));
        return res.json(cats.map((c, i) => ({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 })));
    }

    if (action === 'get_vod_streams') {
        const movieItems = readM3UFile('movie.m3u');
        const cats = Array.from(new Set(movieItems.map(i => i.group)));
        return res.json(movieItems.map((item, index) => ({
            num: index + 1,
            name: item.name,
            stream_id: index + 1000, // Çakışmasın diye yüksek ID
            stream_type: "movie",
            stream_icon: item.logo,
            category_id: (cats.indexOf(item.group) + 1).toString(),
            direct_source: item.url
        })));
    }

    // --- 3. SERIES / DIZILER (series.m3u) ---
    if (action === 'get_series_categories') {
        const seriesItems = readM3UFile('series.m3u');
        if (seriesItems.length === 0) return res.json([{ category_id: "1", category_name: "Dizi Yok", parent_id: 0 }]);
        return res.json([{ category_id: "1", category_name: "Çizgi Diziler", parent_id: 0 }]);
    }

    if (action === 'get_series') {
        const seriesItems = readM3UFile('series.m3u');
        let seriesMap = new Map();

        seriesItems.forEach(item => {
            if (!seriesMap.has(item.seriesName)) {
                seriesMap.set(item.seriesName, { name: item.seriesName, cover: item.logo });
            }
        });

        let seriesList = [];
        let idCounter = 1;
        seriesMap.forEach((data, name) => {
            seriesList.push({
                num: idCounter,
                name: name,
                series_id: idCounter,
                cover: data.cover,
                plot: `${name} Çizgi Dizisi`,
                genre: "Çizgi Dizi",
                category_id: "1"
            });
            idCounter++;
        });

        return res.json(seriesList);
    }

    if (action === 'get_series_info') {
        const seriesItems = readM3UFile('series.m3u');
        const targetId = parseInt(series_id) || 1;

        let seriesMap = new Map();
        seriesItems.forEach(item => {
            if (!seriesMap.has(item.seriesName)) {
                seriesMap.set(item.seriesName, { name: item.seriesName, cover: item.logo, episodes: [] });
            }
            seriesMap.get(item.seriesName).episodes.push(item);
        });

        const seriesNames = Array.from(seriesMap.keys());
        const targetName = seriesNames[targetId - 1];

        if (!targetName) return res.json({ seasons: [], episodes: {} });

        const seriesData = seriesMap.get(targetName);
        let seasonsSet = new Set();
        let episodesObj = {};

        seriesData.episodes.forEach((ep, index) => {
            seasonsSet.add(ep.season);
            const seasonKey = ep.season.toString();

            if (!episodesObj[seasonKey]) episodesObj[seasonKey] = [];

            episodesObj[seasonKey].push({
                id: (index + 2000).toString(),
                episode_num: ep.episode,
                title: ep.name,
                container_extension: "m3u8",
                info: { duration: "11 min", plot: ep.name, movie_image: ep.logo || seriesData.cover }
            });
        });

        const sortedSeasons = Array.from(seasonsSet).sort((a, b) => a - b);
        const seasonsList = sortedSeasons.map(s => ({
            id: s,
            name: `${s}. Sezon`,
            season_number: s,
            cover: seriesData.cover
        }));

        return res.json({
            seasons: seasonsList,
            episodes: episodesObj,
            info: { name: targetName, cover: seriesData.cover }
        });
    }

    res.json([]);
});

// Oynatma Yönlendiricisi
app.get('/:type/:user/:pass/:id', (req, res) => {
    const { user, pass, id } = req.params;
    if (user !== USERNAME || pass !== PASSWORD) return res.status(403).send("Yetkisiz Erişim");

    const cleanId = parseInt(id.replace(/\.[^/.]+$/, ""));
    
    const tvItems = readM3UFile('tv.m3u');
    const movieItems = readM3UFile('movie.m3u');
    const seriesItems = readM3UFile('series.m3u');

    if (cleanId <= 1000 && tvItems[cleanId - 1]) return res.redirect(tvItems[cleanId - 1].url);
    if (cleanId > 1000 && cleanId < 2000 && movieItems[cleanId - 1001]) return res.redirect(movieItems[cleanId - 1001].url);
    if (cleanId >= 2000 && seriesItems[cleanId - 2000]) return res.redirect(seriesItems[cleanId - 2000].url);

    res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));
