const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

// M3U Dosyasını Güvenli Parse Etme
function parseM3U() {
    try {
        const filePath = path.join(__dirname, 'liste.m3u');
        if (!fs.existsSync(filePath)) return { seriesMap: new Map(), streams: [] };
        
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        
        let seriesMap = new Map();
        let streams = [];
        let currentStream = {};

        lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                const logo = logoMatch ? logoMatch[1] : "";

                const groupMatch = line.match(/group-title="([^"]+)"/);
                const rawGroup = groupMatch ? groupMatch[1] : "Sürekli Dizi";
                
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

                currentStream = { name, seriesName, logo, season, episode };
            } else if (line.startsWith('http://') || line.startsWith('https://')) {
                if (currentStream.name) {
                    currentStream.url = line;
                    streams.push(currentStream);

                    if (!seriesMap.has(currentStream.seriesName)) {
                        seriesMap.set(currentStream.seriesName, {
                            name: currentStream.seriesName,
                            cover: currentStream.logo,
                            episodes: []
                        });
                    }
                    
                    if (currentStream.logo && !seriesMap.get(currentStream.seriesName).cover) {
                        seriesMap.get(currentStream.seriesName).cover = currentStream.logo;
                    }

                    seriesMap.get(currentStream.seriesName).episodes.push({
                        ...currentStream,
                        stream_id: streams.length
                    });

                    currentStream = {};
                }
            }
        });

        return { seriesMap, streams };
    } catch (e) {
        return { seriesMap: new Map(), streams: [] };
    }
}

app.get('/player_api.php', (req, res) => {
    const { username, password, action, series_id } = req.query;

    if (username !== USERNAME || password !== PASSWORD) {
        return res.status(401).json({ user_info: { auth: 0 } });
    }

    const { seriesMap, streams } = parseM3U();

    // 1. Giriş Kontrolü
    if (!action) {
        return res.json({
            user_info: { username: USERNAME, auth: 1, status: "Active", exp_date: "1999999999" },
            server_info: { url: req.hostname, port: "80", https_port: "443", server_protocol: "https" }
        });
    }

    // 2. DONMAYI ÖNLEYEN EPG KORUMASI (TV Rehber İsteklerini Hızlıca Kapatır)
    if (action === 'get_epg' || action === 'get_short_epg' || action === 'get_simple_data_table') {
        return res.json({ epg_listings: [] });
    }

    // 3. KATEGORİ TALEPLERİ
    if (action === 'get_live_categories') {
        return res.json([]); // Canlı TV kategorisini direkt boş dön
    }
    if (action === 'get_vod_categories') {
        return res.json([]); // Film kategorisini direkt boş dön
    }
    if (action === 'get_series_categories') {
        return res.json([{ category_id: "1", category_name: "Çizgi Diziler", parent_id: 0 }]);
    }

    // 4. İÇERİK TALEPLERİ
    if (action === 'get_live_streams' || action === 'get_vod_streams') {
        return res.json([]); // Canlı TV ve Filmleri boş dön
    }

    // 5. SERIES (Dizi) Talebi
    if (action === 'get_series') {
        let seriesList = [];
        let idCounter = 1;

        seriesMap.forEach((data, name) => {
            seriesList.push({
                num: idCounter,
                name: name,
                series_id: idCounter,
                cover: data.cover,
                plot: `${name} Çizgi Dizisi`,
                cast: "",
                director: "",
                genre: "Çizgi Dizi",
                releaseDate: "",
                last_modified: "1700000000",
                rating: "9.0",
                category_id: "1"
            });
            idCounter++;
        });

        return res.json(seriesList);
    }

    // 6. Dizi Detayı ve Sezonlar (1..8 Sezon)
    if (action === 'get_series_info') {
        const targetId = parseInt(series_id) || 1;
        const seriesNames = Array.from(seriesMap.keys());
        const targetName = seriesNames[targetId - 1];

        if (!targetName || !seriesMap.has(targetName)) {
            return res.json({ seasons: [], episodes: {} });
        }

        const seriesData = seriesMap.get(targetName);
        let seasonsSet = new Set();
        let episodesObj = {};

        seriesData.episodes.forEach(ep => {
            seasonsSet.add(ep.season);
            const seasonKey = ep.season.toString();

            if (!episodesObj[seasonKey]) {
                episodesObj[seasonKey] = [];
            }

            episodesObj[seasonKey].push({
                id: ep.stream_id.toString(),
                episode_num: ep.episode,
                title: ep.name,
                container_extension: "m3u8",
                info: {
                    duration: "11 min",
                    plot: ep.name,
                    rating: "9.0",
                    movie_image: ep.logo || seriesData.cover
                },
                custom_sid: "",
                added: "1700000000"
            });
        });

        const sortedSeasons = Array.from(seasonsSet).sort((a, b) => a - b);

        const seasonsList = sortedSeasons.map(s => ({
            air_date: "",
            episode_count: episodesObj[s.toString()] ? episodesObj[s.toString()].length : 0,
            id: s,
            name: `${s}. Sezon`,
            overview: "",
            season_number: s,
            cover: seriesData.cover
        }));

        return res.json({
            seasons: seasonsList,
            episodes: episodesObj,
            info: {
                name: targetName,
                cover: seriesData.cover,
                plot: `${targetName} Çizgi Dizisi`,
                genre: "Çizgi Dizi"
            }
        });
    }

    res.json([]);
});

// Stream Yönlendirmesi
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
