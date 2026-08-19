const express = require('express');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200;

const CHANNEL_PROFILES = {
    "kardeş payı": { videoCodec: "copy", audioCodec: "copy" },
    "suskunlar": { videoCodec: "copy", audioCodec: "copy" },
    "adventure time": { videoCodec: "copy", audioCodec: "copy" },
    "default": { videoCodec: "copy", audioCodec: "copy" }
};

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
                const rawGroup = groupMatch ? groupMatch[1] : "Filmler";
                
                let seriesName = rawGroup.split('-')[0].trim();
                let season = 1;

                const seasonInGroup = rawGroup.match(/Sezon\s*(\d+)/i);
                if (seasonInGroup) season = parseInt(seasonInGroup[1]);

                const titleParts = line.split(',');
                const rawTitle = titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : "Bölüm";

                // Bölüm numarası çıkarma (1-1, Bölüm 1, S01E01 vb.)
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
                const partMatch = rawTitle.match(/(?:_P|\(Parça\s*)(\d+)/i);
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
                        cleanUrl = `https://drive.google.com/uc?export=download&confirm=t&id=${idMatch[1]}`;
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

// Dizileri Bölümlere Göre Grupla (Parçaları Birleştir)
function getGroupedSeriesList() {
    const rawItems = readM3UFile('series.m3u');
    const seriesMap = new Map();

    rawItems.forEach(item => {
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

    // Parçaları sırala (P1, P2, P3...)
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
    const seriesMap = getGroupedSeriesList();
    return Array.from(seriesMap.values());
}

// 7/24 Canlı Dizi Akışı: Anlık Parça ve Saniyeyi Hesaplama
function getChannelCurrentSchedule(seriesName) {
    const rawItems = readM3UFile('series.m3u').filter(i => i.seriesName.toLowerCase() === seriesName.toLowerCase());
    if (rawItems.length === 0) return null;

    const totalDuration = rawItems.length * DEFAULT_EP_DURATION;
    const nowSec = Math.floor(Date.now() / 1000);
    let position = nowSec % totalDuration;

    let accumulated = 0;
    for (let i = 0; i < rawItems.length; i++) {
        const ep = rawItems[i];
        const dur = ep.durationInSeconds || DEFAULT_EP_DURATION;
        if (position >= accumulated && position < accumulated + dur) {
            return {
                url: ep.url,
                offset: position - accumulated
            };
        }
        accumulated += dur;
    }
    return { url: rawItems[0].url, offset: 0 };
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

    // CANLI TV KATEGORİLERİ
    if (action === 'get_live_categories') {
        const liveItems = readM3UFile('tv.m3u');
        let categories = [{ category_id: "724_diziler", category_name: "📺 7/24 DİZİLER", parent_id: 0 }];
        if (liveItems.length > 0) {
            const cats = Array.from(new Set(liveItems.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }
        ALPHABET_GROUPS.forEach(group => {
            categories.push({ category_id: group.id, category_name: group.name, parent_id: 0 });
        });
        return res.json(categories);
    }

    // CANLI TV KANALLARI (7/24 Diziler Dahil)
    if (action === 'get_live_streams') {
        const liveItems = readM3UFile('tv.m3u');
        const uniqueSeries = getAllUniqueSeries();
        const cats = Array.from(new Set(liveItems.map(i => i.group)));
        let streams = [];

        // Otomatik 7/24 Canlı Dizi Kanalları (Stream ID: 501 - 599)
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

        // Standart Canlı Kanallar (tv.m3u)
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

    // DİZİLER (Series Menüsü)
    if (action === 'get_series_categories') {
        return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);
    }

    if (action === 'get_series') {
        const uniqueSeries = getAllUniqueSeries();
        let seriesList = uniqueSeries.map((data, index) => ({
            num: index + 1,
            name: data.name,
            series_id: index + 1,
            cover: data.logo,
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

// 🎬 XTREAM OYNATICI KÖPRÜSÜ
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
    const uniqueSeries = getAllUniqueSeries();

    // 1. 7/24 CANLI DİZİ KANALLARI (501 - 599) -> Canlı TS Yayını (İlerleme çubuğu çıkmaz, anlık saatten akar)
    if (cleanId >= 501 && cleanId <= 599) {
        const seriesIdx = cleanId - 501;
        const targetSeries = uniqueSeries[seriesIdx];
        if (targetSeries) {
            const schedule = getChannelCurrentSchedule(targetSeries.name);
            if (schedule && schedule.url) {
                res.setHeader('Content-Type', 'video/mp2t');

                const ffmpegProcess = ffmpeg(schedule.url)
                    .seekInput(schedule.offset)
                    .inputOptions([
                        '-re',
                        '-reconnect 1',
                        '-reconnect_at_eof 1',
                        '-reconnect_streamed 1',
                        '-reconnect_delay_max 5'
                    ])
                    .outputOptions([
                        '-c:v copy',
                        '-c:a copy',
                        '-f mpegts'
                    ])
                    .on('error', (err) => {
                        // Oynatıcı kapatıldığında hata vermeden çık
                    });

                ffmpegProcess.pipe(res, { end: true });

                req.on('close', () => {
                    ffmpegProcess.kill('SIGKILL');
                });
                return;
            }
        }
    }

    // 2. NORMAL CANLI TV (1 - 500) -> 302 Yönlendirme
    if (cleanId <= 500 && tvItems[cleanId - 1]) {
        return res.redirect(302, tvItems[cleanId - 1].url);
    }
    
    // 3. FILMLER (1001 - 1999) -> 302 Yönlendirme
    if (cleanId > 1000 && cleanId < 2000 && movieItems[cleanId - 1001]) {
        return res.redirect(302, movieItems[cleanId - 1001].url);
    }
    
    // 4. DIZI BÖLÜMÜ (100000+) -> Bölümün İlk/Ana Parçasına Yönlendirme
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

app.listen(PORT, () => console.log(`Xtream IPTV Sunucusu ${PORT} portunda devrede.`));
