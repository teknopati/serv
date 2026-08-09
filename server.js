const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

// 📌 1. Sezon 1. Bölüm 0. Saniye Referansı (Dünya Saati Anchor)
const START_ANCHOR_TIME = 1786233600; 

// M3U Okuyucu
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

// 🕒 ARKA PLANDA KESİNTİSİZ DÖNEN CANLI SAAT MOTORU
function getLiveStateForSeries(targetSeriesName) {
    const allSeries = readM3UFile('series.m3u');
    
    const filteredEpisodes = allSeries.filter(item => 
        item.seriesName.toLowerCase() === targetSeriesName.toLowerCase()
    );

    const episodes = filteredEpisodes.length > 0 ? filteredEpisodes : allSeries;
    if (episodes.length === 0) return null;

    const episodeDuration = 11 * 60; // Her bölüm 11 Dakika (660 Saniye)
    const totalLoopDuration = episodes.length * episodeDuration;
    
    const nowInSeconds = Math.floor(Date.now() / 1000);
    
    // Sen bakmasan da arka planda akan toplam saniye
    let elapsedSeconds = nowInSeconds - START_ANCHOR_TIME;
    if (elapsedSeconds < 0) elapsedSeconds = 0;

    // Döngüdeki anlık saniye konumu
    const currentLoopPosition = elapsedSeconds % totalLoopDuration;
    
    // Hangi bölümdeyiz?
    const currentIndex = Math.floor(currentLoopPosition / episodeDuration);
    
    // O bölümün TAM KAÇINCI SANİYESİNDEYİZ? (1 ile 660 saniye arası)
    const offsetSeconds = currentLoopPosition % episodeDuration;

    return {
        episode: episodes[currentIndex],
        currentIndex: currentIndex,
        offsetSeconds: offsetSeconds,
        totalEpisodes: episodes.length
    };
}

// 📡 M3U8 Dosyasına Canlı Yayın Saniyesini Enjekte Eden Motor
function serveLiveManifestWithOffset(targetUrl, offsetSeconds, res) {
    try {
        const parsedUrl = new URL(targetUrl);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`
            }
        };

        const client = parsedUrl.protocol === 'https:' ? https : http;

        client.get(options, (streamRes) => {
            let data = '';
            streamRes.on('data', chunk => data += chunk);
            streamRes.on('end', () => {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

                const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                let lines = data.split('\n');
                let newLines = [];

                lines.forEach(line => {
                    line = line.trim();
                    
                    // Video bitiş etiketini sil (Televizyon yayını canlı sanıp durdurmasın)
                    if (line === '#EXT-X-ENDLIST') {
                        return;
                    }

                    // EXTM3U etiketinden hemen sonra ANLIK CANLI SANİYEYİ enjekte et!
                    if (line === '#EXTM3U') {
                        newLines.push(line);
                        newLines.push(`#EXT-X-START:TIME-OFFSET=${offsetSeconds}`);
                    } else if (line && !line.startsWith('#') && !line.startsWith('http')) {
                        newLines.push(baseUrl + line);
                    } else {
                        newLines.push(line);
                    }
                });

                res.send(newLines.join('\n'));
            });
        }).on('error', () => res.status(500).send("Canlı yayın verisi okunamadı"));
    } catch (e) {
        res.status(500).send("Geçersiz Adres");
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

    if (action === 'get_epg' || action === 'get_short_epg' || action === 'get_simple_data_table') {
        return res.json({ epg_listings: [] });
    }

    // --- 1. TV MENÜSÜ KATEGORİLERİ ---
    if (action === 'get_live_categories') {
        const liveItems = readM3UFile('tv.m3u');
        
        let categories = [{ category_id: "724", category_name: "📺 7/24 DİZİ KANALLARI", parent_id: 0 }];
        
        if (liveItems.length > 0) {
            const cats = Array.from(new Set(liveItems.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 100).toString(), category_name: c, parent_id: 0 }));
        }
        return res.json(categories);
    }

    // --- TV KANALLARI VE 7/24 KANALLAR ---
    if (action === 'get_live_streams') {
        const liveItems = readM3UFile('tv.m3u');
        const seriesItems = readM3UFile('series.m3u');
        const cats = Array.from(new Set(liveItems.map(i => i.group)));
        
        const uniqueSeriesNames = Array.from(new Set(seriesItems.map(i => i.seriesName)));
        
        let streams = [];
        let streamIdCounter = 9000;

        uniqueSeriesNames.forEach((sName, index) => {
            const liveState = getLiveStateForSeries(sName);
            const logo = seriesItems.find(i => i.seriesName === sName)?.logo || "";
            
            streams.push({
                num: index + 1,
                name: (liveState && liveState.episode) ? `7/24 ${sName} (${liveState.episode.name})` : `7/24 ${sName}`,
                stream_id: streamIdCounter + index,
                stream_type: "live",
                stream_icon: logo || "https://image.tmdb.org/t/p/w1280/7MnzSQ7YV29EeqXFuGXpClfcRCc.jpg",
                category_id: "724",
                container_extension: "m3u8",
                custom_sid: "",
                direct_source: ""
            });
        });

        const baseNum = streams.length + 1;
        liveItems.forEach((item, index) => {
            streams.push({
                num: baseNum + index,
                name: item.name,
                stream_id: index + 1,
                stream_type: "live",
                stream_icon: item.logo,
                category_id: (cats.indexOf(item.group) + 100).toString(),
                container_extension: "m3u8",
                direct_source: item.url
            });
        });

        return res.json(streams);
    }

    // --- 2. MOVIE MENÜSÜ ---
    if (action === 'get_vod_categories') return res.json([{ category_id: "1", category_name: "Film Yok", parent_id: 0 }]);
    if (action === 'get_vod_streams') return res.json([]);

    // --- 3. SERIES MENÜSÜ ---
    if (action === 'get_series_categories') {
        const seriesItems = readM3UFile('series.m3u');
        if (seriesItems.length === 0) return res.json([{ category_id: "1", category_name: "Dizi Yok", parent_id: 0 }]);
        return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);
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
                plot: `${name} Dizisi`,
                genre: "Çizgi Dizi / Dizi",
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

// Oynatma Yönlendiricisi (Canlı Saniye Offset Enjeksiyonlu)
app.get('/:type/:user/:pass/:id', (req, res) => {
    const { user, pass, id } = req.params;
    if (user !== USERNAME || pass !== PASSWORD) return res.status(403).send("Yetkisiz Erişim");

    const cleanId = parseInt(id.replace(/\.[^/.]+$/, ""));

    // 7/24 Canlı Dizi Kanalları İsteği (9000+)
    if (cleanId >= 9000 && cleanId < 9999) {
        const seriesItems = readM3UFile('series.m3u');
        const uniqueSeriesNames = Array.from(new Set(seriesItems.map(i => i.seriesName)));
        const targetIndex = cleanId - 9000;
        const targetSeriesName = uniqueSeriesNames[targetIndex];

        if (targetSeriesName) {
            const liveState = getLiveStateForSeries(targetSeriesName);
            if (liveState && liveState.episode && liveState.episode.url) {
                // Bölümü 0. saniyeden değil, o anki canlı saniyesinden başlatan özel fonksiyon:
                return serveLiveManifestWithOffset(liveState.episode.url, liveState.offsetSeconds, res);
            }
        }
    }

    const tvItems = readM3UFile('tv.m3u');
    const movieItems = readM3UFile('movie.m3u');
    const seriesItems = readM3UFile('series.m3u');

    if (cleanId <= 900 && tvItems[cleanId - 1]) return res.redirect(302, tvItems[cleanId - 1].url);
    if (cleanId > 1000 && cleanId < 2000 && movieItems[cleanId - 1001]) return res.redirect(302, movieItems[cleanId - 1001].url);
    if (cleanId >= 2000 && seriesItems[cleanId - 2000]) return res.redirect(302, seriesItems[cleanId - 2000].url);

    res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));
