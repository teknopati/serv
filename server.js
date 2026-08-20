const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200; // Her parça varsayılan 20 dakika (1200 saniye)

let cacheTV = [];
let cacheMovies = [];
let cacheSeries = [];

function loadPlaylists() {
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

loadPlaylists();

function getAllUniqueSeries() {
    const seriesMap = new Map();
    cacheSeries.forEach((item, index) => {
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

// Her dizi için TV'de bir "Dizi Kanalı" oluşturan motor
function getSeriesAsVirtualTvChannels() {
    const uniqueSeries = getAllUniqueSeries();
    let channels = [];
    
    uniqueSeries.forEach((series, index) => {
        const streamId = 80000 + index; // Çakışmayı önlemek için özel ID
        channels.push({
            stream_id: streamId,
            name: `📺 ${series.name} (7/24 Dizi TV)`,
            stream_icon: series.logo,
            items: series.items // O dizinin tüm parçaları sırayla
        });
    });

    return channels;
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

    // 1. CANLI KATEGORİLER (Normal TV Grupları + "7/24 Dizi Kanalları" Kategorisi)
    if (action === 'get_live_categories') {
        let categories = [];
        if (cacheTV.length > 0) {
            const cats = Array.from(new Set(cacheTV.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }
        // Özel Dizi Kanalları Kategorisi
        categories.push({ category_id: "9999", category_name: "📺 7/24 Dizi Kanalları", parent_id: 0 });
        return res.json(categories);
    }

    // 2. CANLI KANALLAR (Normal Kanallar + 7/24 Dizi Kanalları)
    if (action === 'get_live_streams') {
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        let streams = [];

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

        // 7/24 Dizi Kanallarını ekle
        const virtualChannels = getSeriesAsVirtualTvChannels();
        virtualChannels.forEach(vc => {
            streams.push({
                num: streams.length + 1,
                name: vc.name,
                stream_id: vc.stream_id,
                stream_type: "live",
                stream_icon: vc.stream_icon,
                category_id: "9999",
                // Oynatıcıyı bizim akış saatine göre yönlendiriyoruz
                direct_source: `http://${req.headers.host}/virtual_stream/${vc.stream_id}`
            });
        });

        if (category_id) {
            streams = streams.filter(s => s.category_id === category_id.toString());
        } else {
            streams = streams.slice(0, 100); // İlk açılışta donmayı önler
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

    // 4. DİZİLER (SERIES - Orijinal kusursuz yapısı)
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
                    movie_image: item.logo || targetSeries.logo 
                }
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

// 🕒 TV SAATİNE GÖRE AKIŞ YÖNETİCİSİ (Virtual TV Stream)
app.get('/virtual_stream/:streamId', (req, res) => {
    const streamId = parseInt(req.params.streamId);
    const virtualChannels = getSeriesAsVirtualTvChannels();
    const channel = virtualChannels.find(vc => vc.stream_id === streamId);

    if (!channel || channel.items.length === 0) {
        return res.status(404).send("Kanal bulunamadı");
    }

    // Günün başlangıcından (00:00:00) bu yana geçen toplam saniye
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const totalSecondsToday = Math.floor((now - startOfDay) / 1000);

    // Her parçanın süresi kadar döngü kuruyoruz (Tüm dizinin toplam süresi)
    let totalPlaylistDuration = channel.items.reduce((acc, item) => acc + (item.durationInSeconds || DEFAULT_EP_DURATION), 0);
    
    // Günün hangi saniyesindeysek, döngüsel olarak hangi parçaya denk geldiğimizi buluyoruz
    let currentSecondInLoop = totalSecondsToday % totalPlaylistDuration;

    let accumulatedTime = 0;
    let activeItem = channel.items[0];

    for (let item of channel.items) {
        let itemDuration = item.durationInSeconds || DEFAULT_EP_DURATION;
        if (currentSecondInLoop >= accumulatedTime && currentSecondInLoop < (accumulatedTime + itemDuration)) {
            activeItem = item;
            break;
        }
        accumulatedTime += itemDuration;
    }

    let targetUrl = activeItem.url;
    if (targetUrl.includes("drive.usercontent")) {
        return res.redirect(302, targetUrl);
    }
    const finalUrl = targetUrl.replace(/id=([a-zA-Z0-9_-]+)/, "https://drive.usercontent.google.com/download?id=$1&export=download&confirm=t");
    
    return res.redirect(302, finalUrl);
});

// 🎬 NORMAL YAYIN YÖNLENDİRİCİ
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { user, pass, id } = req.params;

    if (user !== USERNAME || pass !== PASSWORD) {
        return res.status(403).send("Yetkisiz Erişim");
    }

    const cleanIdMatch = id.match(/^(\d+)/);
    if (!cleanIdMatch) return res.status(400).send("Geçersiz Yayın ID");

    const cleanId = parseInt(cleanIdMatch[1]);
    const uniqueSeries = getAllUniqueSeries();

    let targetUrl = null;

    if (cleanId <= 500 && cacheTV[cleanId - 1]) {
        targetUrl = cacheTV[cleanId - 1].url;
    } else if (cleanId > 1000 && cleanId < 2000 && movieItems[cleanId - 1001]) {
        targetUrl = cacheMovies[cleanId - 1001].url;
    } else if (cleanId >= 10001) {
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

    return res.redirect(302, targetUrl);
});

app.listen(PORT, () => console.log(`7/24 Dizi TV Akış Sunucusu ${PORT} portunda devrede.`));
