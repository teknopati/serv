const express = require('express');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200;

// Her dizinin kendine has teknik profil tanımları
const CHANNEL_PROFILES = {
    "kardeş payı": {
        videoCodec: "libx264",
        audioCodec: "aac",
        fps: 25.0,
        sampleRate: 44100,
        width: 1280,
        height: 720,
        bitrate: "1000k"
    },
    "suskunlar": {
        // TV uyumluluğu için AV1 kaynaklar libx264/AAC ile hafifçe paketlenir veya donanım desteğine göre verilir
        videoCodec: "libx264",
        audioCodec: "aac",
        fps: 25.0,
        sampleRate: 48000,
        width: 1280,
        height: 720,
        bitrate: "800k"
    },
    "adventure time": {
        videoCodec: "libx264",
        audioCodec: "aac",
        fps: 23.98,
        sampleRate: 44100,
        width: 1280,
        height: 720,
        bitrate: "1200k"
    },
    "default": {
        videoCodec: "libx264",
        audioCodec: "aac",
        fps: 25.0,
        sampleRate: 44100,
        width: 1280,
        height: 720,
        bitrate: "1000k"
    }
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

                let durationInSeconds = DEFAULT_EP_DURATION;
                if (parsedDuration > 0) {
                    durationInSeconds = parsedDuration;
                }

                currentItem = { name, group: rawGroup, seriesName, logo, season, episode, durationInSeconds };
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

function getAllUniqueSeries() {
    const seriesItems = readM3UFile('series.m3u');
    let seriesMap = new Map();
    seriesItems.forEach(item => {
        if (!seriesMap.has(item.seriesName)) {
            seriesMap.set(item.seriesName, { name: item.seriesName, logo: item.logo });
        }
    });
    return Array.from(seriesMap.values());
}

function getSeriesProfile(seriesName) {
    const key = seriesName.toLowerCase().trim();
    for (let p in CHANNEL_PROFILES) {
        if (key.includes(p)) return CHANNEL_PROFILES[p];
    }
    return CHANNEL_PROFILES["default"];
}

// 7/24 Zaman & Bölüm Akışı Hesaplama
function getChannelCurrentSchedule(seriesName) {
    const seriesItems = readM3UFile('series.m3u');
    const episodes = seriesItems.filter(item => item.seriesName.toLowerCase() === seriesName.toLowerCase());
    if (episodes.length === 0) return null;

    const totalDuration = episodes.reduce((acc, ep) => acc + (ep.durationInSeconds || DEFAULT_EP_DURATION), 0);
    const currentEpoch = Math.floor(Date.now() / 1000);
    let position = currentEpoch % totalDuration;

    let accumulated = 0;
    for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i];
        const dur = ep.durationInSeconds || DEFAULT_EP_DURATION;
        if (position >= accumulated && position < accumulated + dur) {
            return {
                url: ep.url,
                offset: position - accumulated,
                seriesName: seriesName,
                profile: getSeriesProfile(seriesName)
            };
        }
        accumulated += dur;
    }
    return { url: episodes[0].url, offset: 0, seriesName: seriesName, profile: getSeriesProfile(seriesName) };
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

    // CANLI TV KANALLARI
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

        // tv.m3u'daki Standart Canlı Kanallar (Stream ID: 1 - 500)
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

    // DİZİLER
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

            const globalEpisodeId = (targetId * 10000) + index + 1;
            episodesObj[seasonKey].push({
                id: globalEpisodeId.toString(),
                episode_num: ep.episode,
                title: ep.name,
                container_extension: "mp4",
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
    const seriesItems = readM3UFile('series.m3u');
    const uniqueSeries = getAllUniqueSeries();

    // 1. 7/24 DİZİ KANALLARI (501 - 599) -> Kendi Video Profiline Göre Doğrudan Yönlendirme (HLS / MP4)
    if (cleanId >= 501 && cleanId <= 599) {
        const seriesIdx = cleanId - 501;
        const targetSeries = uniqueSeries[seriesIdx];
        if (targetSeries) {
            const schedule = getChannelCurrentSchedule(targetSeries.name);
            if (schedule && schedule.url) {
                return res.redirect(302, schedule.url);
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
    
    // 4. DIZILER (10001+) -> 302 Yönlendirme
    if (cleanId >= 10001) {
        const seriesIndex = Math.floor(cleanId / 10000) - 1;
        const episodeIndex = (cleanId % 10000) - 1;
        const targetSeries = uniqueSeries[seriesIndex];

        if (targetSeries) {
            const targetEpisodes = seriesItems.filter(item => item.seriesName.toLowerCase() === targetSeries.name.toLowerCase());
            if (targetEpisodes[episodeIndex] && targetEpisodes[episodeIndex].url) {
                return res.redirect(302, targetEpisodes[episodeIndex].url);
            }
        }
    }

    return res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Xtream IPTV Sunucusu ${PORT} portunda devrede.`));
