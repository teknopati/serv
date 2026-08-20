const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";
const DEFAULT_EP_DURATION = 1200;

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

// DİZİLERİ SEZON VE BÖLÜMLERE GÖRE GRUplayan Gelişmiş Mantık (Parçaları Birleştirir)
function getStructuredSeries() {
    const rawItems = readM3UFile('series.m3u');
    const seriesMap = new Map();

    rawItems.forEach((item) => {
        const sKey = item.seriesName.toLowerCase();
        if (!seriesMap.has(sKey)) {
            seriesMap.set(sKey, {
                name: item.seriesName,
                logo: item.logo,
                episodesMap: new Map() // Bölümleri tutacak
            });
        }

        const seriesObj = seriesMap.get(sKey);
        const seasonNum = item.season || 1;
        const episodeNum = item.episode || 1;
        const epKey = `${seasonNum}-${episodeNum}`;

        if (!seriesObj.episodesMap.has(epKey)) {
            seriesObj.episodesMap.set(epKey, {
                season: seasonNum,
                episode: episodeNum,
                title: `${seasonNum}. Sezon ${episodeNum}. Bölüm`,
                logo: item.logo,
                parts: [] // Bu bölüme ait parçalar (örn: Parça 1, Parça 2)
            });
        }

        // Parçaları sırasına göre ekle
        seriesObj.episodesMap.get(epKey).parts.push(item);
    });

    // Map yapısını diziye çevir
    let formattedSeries = [];
    let seriesIndex = 0;

    for (let [_, seriesData] of seriesMap) {
        let seasonsObj = {};
        let episodesList = [];
        let globalEpisodeCounter = 1;

        // Bölümleri diziye dök ve sırala
        let sortedEpisodes = Array.from(seriesData.episodesMap.values()).sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
        });

        sortedEpisodes.forEach((ep) => {
            const seasonKey = ep.season.toString();
            if (!seasonsObj[seasonKey]) seasonsObj[seasonKey] = [];

            // Bu bölümün toplam süresi (tüm parçaların süreleri toplamı)
            let totalDurationSecs = ep.parts.reduce((acc, p) => acc + p.durationInSeconds, 0);

            // Her bölüm için benzersiz bir ID oluşturuyoruz (Dizi ID * 10000 + Bölüm ID)
            const uniqueEpId = ((seriesIndex + 1) * 10000) + globalEpisodeCounter;

            episodesList.push({
                globalEpId: uniqueEpId,
                season: ep.season,
                episode: ep.episode,
                title: `${ep.season}. Sezon ${ep.episode}. Bölüm`,
                logo: ep.logo || seriesData.logo,
                duration: totalDurationSecs,
                parts: ep.parts // Parçaların link listesi
            });

            seasonsObj[seasonKey].push({
                id: uniqueEpId.toString(),
                episode_num: globalEpisodeCounter,
                title: `${ep.season}. Sezon ${ep.episode}. Bölüm`,
                container_extension: "mp4",
                info: {
                    duration_secs: totalDurationSecs,
                    duration: `${Math.round(totalDurationSecs / 60)} min`,
                    plot: `${seriesData.name} - ${ep.season}. Sezon ${ep.episode}. Bölüm`,
                    movie_image: ep.logo || seriesData.logo
                }
            });

            globalEpisodeCounter++;
        });

        formattedSeries.push({
            id: seriesIndex + 1,
            name: seriesData.name,
            logo: seriesData.logo,
            seasons: Object.keys(seasonsObj).map(s => ({ id: parseInt(s), name: `${s}. Sezon`, season_number: parseInt(s), cover: seriesData.logo })),
            episodesObj: seasonsObj,
            rawEpisodesList: episodesList
        });

        seriesIndex++;
    }

    return formattedSeries;
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

    // CANLI KATEGORİLER
    if (action === 'get_live_categories') {
        const liveItems = readM3UFile('tv.m3u');
        let categories = [];
        if (liveItems.length > 0) {
            const cats = Array.from(new Set(liveItems.map(i => i.group)));
            cats.forEach((c, i) => categories.push({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        }
        ALPHABET_GROUPS.forEach(group => {
            categories.push({ category_id: group.id, category_name: group.name, parent_id: 0 });
        });
        return res.json(categories);
    }

    // CANLI KANALLAR
    if (action === 'get_live_streams') {
        const liveItems = readM3UFile('tv.m3u');
        const cats = Array.from(new Set(liveItems.map(i => i.group)));
        let streams = [];

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

    // DİZİLER (Series - Sezon ve Bölüm Listesi)
    if (action === 'get_series_categories') {
        return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);
    }

    if (action === 'get_series') {
        const structuredSeries = getStructuredSeries();
        let seriesList = structuredSeries.map((data) => ({
            num: data.id,
            name: data.name,
            series_id: data.id,
            cover: data.logo,
            plot: `${data.name} Dizisi`,
            genre: "Dizi / Çizgi Dizi",
            category_id: "1"
        }));
        return res.json(seriesList);
    }

    if (action === 'get_series_info') {
        const targetId = parseInt(series_id) || 1;
        const structuredSeries = getStructuredSeries();
        const targetSeries = structuredSeries.find(s => s.id === targetId);

        if (!targetSeries) return res.json({ seasons: [], episodes: {} });

        return res.json({
            seasons: targetSeries.seasons,
            episodes: targetSeries.episodesObj,
            info: { name: targetSeries.name, cover: targetSeries.logo }
        });
    }

    res.json([]);
});

// 🎬 BÖLÜM PARÇALARINI BİRLEŞTİREREK OYNATAN MOTOR (İleri/Geri sarma destekli)
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
    const structuredSeries = getStructuredSeries();

    let targetUrl = null;
    let targetEpisodeParts = null;

    // 1. Canlı TV
    if (cleanId <= 500 && tvItems[cleanId - 1]) {
        targetUrl = tvItems[cleanId - 1].url;
    }
    // 2. Filmler
    else if (cleanId > 1000 && cleanId < 2000 && movieItems[cleanId - 1001]) {
        targetUrl = movieItems[cleanId - 1001].url;
    }
    // 3. Diziler (Bölüm ID'sine göre parçaları bul)
    else if (cleanId >= 10000) {
        for (let series of structuredSeries) {
            const foundEp = series.rawEpisodesList.find(ep => ep.globalEpId === cleanId);
            if (foundEp) {
                targetEpisodeParts = foundEp.parts.map(p => p.url);
                break;
            }
        }
    }

    // Eğer normal bir kanal/film ise tekil linki aç
    if (targetUrl) {
        try {
            const response = await axios({
                method: 'get',
                url: targetUrl,
                responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 10000
            });
            res.setHeader('Content-Type', 'video/mp4');
            return response.data.pipe(res);
        } catch (err) {
            return res.redirect(302, targetUrl);
        }
    }

    // Eğer dizi bölümü ise parçaları sırayla arkaya arkaya (zincirleme) akıt
    if (targetEpisodeParts && targetEpisodeParts.length > 0) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Connection', 'keep-alive');

        let partIndex = 0;

        async function streamPart() {
            if (partIndex >= targetEpisodeParts.length) {
                return res.end(); // Tüm parçalar bittiğinde akışı sonlandır
            }

            const currentPartUrl = targetEpisodeParts[partIndex];
            partIndex++;

            try {
                const response = await axios({
                    method: 'get',
                    url: currentPartUrl,
                    responseType: 'stream',
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });

                response.data.on('end', () => {
                    streamPart(); // Birinci parça bittiği an ikinci parçaya geç
                });

                response.data.on('error', () => {
                    streamPart();
                });

                response.data.pipe(res, { end: false });
            } catch (err) {
                streamPart();
            }
        }

        streamPart();
        return;
    }

    return res.status(404).send("Yayın bulunamadı");
});

app.listen(PORT, () => console.log(`Xtream IPTV Sunucusu ${PORT} portunda devrede.`));
