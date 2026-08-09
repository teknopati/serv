const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

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

// 🕒 Anlık Bölüm ve Saniye Hesabı
function getSurekliDiziLiveState() {
    const allSeries = readM3UFile('series.m3u');
    
    const surekliDiziEpisodes = allSeries.filter(item => 
        item.seriesName.toLowerCase().includes("sürekli dizi") || 
        item.seriesName.toLowerCase().includes("regular show") ||
        item.group.toLowerCase().includes("sürekli dizi")
    );

    const targetEpisodes = surekliDiziEpisodes.length > 0 ? surekliDiziEpisodes : allSeries;
    if (targetEpisodes.length === 0) return null;

    const episodeDuration = 11 * 60; // 11 Dakika (660 Saniye)
    const totalDuration = targetEpisodes.length * episodeDuration;
    const nowInSeconds = Math.floor(Date.now() / 1000);

    const currentLoopPos = nowInSeconds % totalDuration;
    const currentIndex = Math.floor(currentLoopPos / episodeDuration);
    const offsetSeconds = currentLoopPos % episodeDuration;

    return {
        episode: targetEpisodes[currentIndex],
        currentIndex: currentIndex,
        offsetSeconds: offsetSeconds,
        totalEpisodes: targetEpisodes.length,
        allEpisodes: targetEpisodes
    };
}

// M3U8 Dosyasını Çekip Ayrıştıran Yardımcı Fonksiyon
function fetchM3U8Content(targetUrl) {
    return new Promise((resolve) => {
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
                streamRes.on('end', () => resolve({ data, targetUrl }));
            }).on('error', () => resolve(null));
        } catch (e) {
            resolve(null);
        }
    });
}

// 📡 Gerçek 7/24 Canlı Yayın Manifestosu (Live HLS Feed)
async function generateLiveHLSStream(res) {
    const liveState = getSurekliDiziLiveState();
    if (!liveState) return res.status(404).send("Yayın Yok");

    const fetched = await fetchM3U8Content(liveState.episode.url);
    if (!fetched || !fetched.data) {
        // Eğer o anki M3U8 çekilemezse orijinal linke yönlendir
        return res.redirect(302, liveState.episode.url);
    }

    const baseUrl = fetched.targetUrl.substring(0, fetched.targetUrl.lastIndexOf('/') + 1);
    const lines = fetched.data.split('\n');

    let isMaster = false;
    let subManifestUrl = null;

    // Eğer çekilen dosya bir Master M3U8 ise en yüksek kaliteli alt M3U8'i seç
    lines.forEach(line => {
        line = line.trim();
        if (line.includes('.m3u8')) {
            isMaster = true;
            subManifestUrl = line.startsWith('http') ? line : baseUrl + line;
        }
    });

    if (isMaster && subManifestUrl) {
        const subFetched = await fetchM3U8Content(subManifestUrl);
        if (subFetched && subFetched.data) {
            return processAndServeChunks(subFetched.data, subFetched.targetUrl, liveState.offsetSeconds, res);
        }
    }

    return processAndServeChunks(fetched.data, fetched.targetUrl, liveState.offsetSeconds, res);
}

// .ts Parçalarını Saat Offsetine Göre Canlı Akışa Dönüştüren Motor
function processAndServeChunks(manifestData, manifestUrl, offsetSeconds, res) {
    const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
    const lines = manifestData.split('\n');

    let segments = [];
    let currentDuration = 0;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const durationMatch = line.match(/#EXTINF:([\d\.]+)/);
            const duration = durationMatch ? parseFloat(durationMatch[1]) : 10;
            const mediaUrlLine = lines[i + 1] ? lines[i + 1].trim() : '';

            if (mediaUrlLine && !mediaUrlLine.startsWith('#')) {
                const fullMediaUrl = mediaUrlLine.startsWith('http') ? mediaUrlLine : baseUrl + mediaUrlLine;
                segments.push({
                    duration: duration,
                    url: fullMediaUrl
                });
            }
        }
    }

    // Toplam süre içinde saatimizin denk geldiği .ts segmentini bul
    let accumulatedTime = 0;
    let startIndex = 0;

    for (let i = 0; i < segments.length; i++) {
        accumulatedTime += segments[i].duration;
        if (accumulatedTime >= offsetSeconds) {
            startIndex = i;
            break;
        }
    }

    // Gerçek 7/24 Canlı Yayın M3U8 Başlığı Oluştur
    const sequence = Math.floor(Date.now() / 10000);
    let outputManifest = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
        '#EXT-X-DISCONTINUITY'
    ];

    // O anki saniyeden itibaren geleceğe doğru segmentleri ekle (VOD değil Canlı Akış!)
    const liveWindowSegments = segments.slice(startIndex, startIndex + 30);
    liveWindowSegments.forEach(seg => {
        outputManifest.push(`#EXTINF:${seg.duration.toFixed(3)},`);
        outputManifest.push(seg.url);
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(outputManifest.join('\n'));
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

    // --- 1. TV MENÜSÜ ---
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
        const liveState = getSurekliDiziLiveState();
        
        let streams = [{
            num: 1,
            name: (liveState && liveState.episode) ? `Sürekli Dizi 7/24 (${liveState.episode.name})` : "Sürekli Dizi (7/24 Canlı TV)",
            stream_id: 999,
            stream_type: "live",
            stream_icon: "https://image.tmdb.org/t/p/w1280/7MnzSQ7YV29EeqXFuGXpClfcRCc.jpg",
            category_id: "724",
            direct_source: ""
        }];

        liveItems.forEach((item, index) => {
            streams.push({
                num: index + 2,
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

// Oynatma İstekleri
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;
    if (user !== USERNAME || pass !== PASSWORD) return res.status(403).send("Yetkisiz Erişim");

    const cleanId = parseInt(id.replace(/\.[^/.]+$/, ""));

    // 7/24 Canlı Dizi Kanalı İsteği
    if (cleanId === 999) {
        return generateLiveHLSStream(res);
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
