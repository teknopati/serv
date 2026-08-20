const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = "admin";
const PASSWORD = "123";

// Performans ve hız için listeleri bir kez belleğe alıyoruz (Her istekte dosya okumayı keser, donmayı bitirir)
let cacheTV = [];
let cacheSeries = [];

function loadPlaylists() {
    cacheTV = readM3UFile('tv.m3u');
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
                const groupMatch = line.match(/group-title="([^"]+)"/);
                const titleParts = line.split(',');
                const rawTitle = titleParts[titleParts.length - 1].trim();
                
                let season = 1;
                let episode = 1;
                const seasonInGroup = groupMatch ? groupMatch[1].match(/Sezon\s*(\d+)/i) : null;
                if (seasonInGroup) season = parseInt(seasonInGroup[1]);

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
                if (partMatch) partNum = parseInt(partMatch[1]);

                currentItem = { 
                    name: rawTitle, 
                    group: groupMatch ? groupMatch[1] : "Genel",
                    seriesName: groupMatch ? groupMatch[1].split('-')[0].trim() : "Dizi",
                    season,
                    episode,
                    partNum
                };
            } else if (line && !line.startsWith('#')) {
                let cleanUrl = line;
                const idMatch = line.match(/id=([a-zA-Z0-9_-]+)/);
                if (idMatch) {
                    cleanUrl = `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&confirm=t`;
                }
                currentItem.url = cleanUrl;
                items.push(currentItem);
                currentItem = {};
            }
        });
        return items;
    } catch (e) { return []; }
}

loadPlaylists();

function getAllUniqueSeries() {
    const seriesMap = new Map();
    cacheSeries.forEach((item, index) => {
        const sKey = item.seriesName.toLowerCase();
        if (!seriesMap.has(sKey)) seriesMap.set(sKey, { name: item.seriesName, items: [] });
        seriesMap.get(sKey).items.push(item);
    });
    return Array.from(seriesMap.values());
}

function getSeriesAsLiveCategoriesAndStreams() {
    const uniqueSeries = getAllUniqueSeries();
    let categories = [];
    let streams = [];
    
    let catIdCounter = 1000;
    let streamIdCounter = 50000;

    uniqueSeries.forEach(series => {
        const currentCatId = catIdCounter.toString();
        categories.push({
            category_id: currentCatId,
            category_name: `📺 ${series.name}`,
            parent_id: 0
        });

        series.items.forEach((item) => {
            let displayName = item.name;
            if (!displayName.toLowerCase().includes("parça") && item.partNum > 1) {
                displayName = `${item.season}. Sezon ${item.episode}. Bölüm (Parça ${item.partNum})`;
            }

            streams.push({
                stream_id: streamIdCounter,
                name: displayName,
                category_id: currentCatId,
                direct_source: item.url
            });
            streamIdCounter++;
        });
        catIdCounter++;
    });

    return { categories, streams };
}

app.get('/player_api.php', (req, res) => {
    const { action, category_id, series_id } = req.query;

    // 1. CANLI KATEGORİLER
    if (action === 'get_live_categories') {
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        let tvCategories = cats.map((c, i) => ({ category_id: (i + 1).toString(), category_name: c, parent_id: 0 }));
        
        const { categories: seriesCategories } = getSeriesAsLiveCategoriesAndStreams();
        return res.json(tvCategories.concat(seriesCategories));
    }

    // 2. CANLI KANALLAR (Akıllı filtreleme: Alıcıyı kilitlemeden sadece tıklanan kategoriyi döner)
    if (action === 'get_live_streams') {
        const cats = Array.from(new Set(cacheTV.map(i => i.group)));
        let streams = cacheTV.map((item, index) => ({
            stream_id: index + 1,
            name: item.name,
            category_id: (cats.indexOf(item.group) + 1).toString(),
            direct_source: item.url
        }));

        const { streams: seriesStreams } = getSeriesAsLiveCategoriesAndStreams();
        streams = streams.concat(seriesStreams);

        if (category_id) {
            return res.json(streams.filter(s => s.category_id === category_id.toString()));
        }
        // Kategori seçilmediyse ilk 100 kanalı vererek alıcının siyah ekranda kalmasını önleriz
        return res.json(streams.slice(0, 100));
    }

    // 3. DİZİLER (SERIES - Orijinal menü bozulmadan duruyor)
    if (action === 'get_series_categories') return res.json([{ category_id: "1", category_name: "Tüm Diziler", parent_id: 0 }]);

    if (action === 'get_series') {
        const series = getAllUniqueSeries();
        return res.json(series.map((s, i) => ({ series_id: i + 1, name: s.name, category_id: "1" })));
    }

    if (action === 'get_series_info') {
        const series = getAllUniqueSeries();
        const target = series[parseInt(series_id) - 1];
        if (!target) return res.json({ episodes: {} });
        return res.json({ episodes: { "1": target.items.map((it, i) => ({ id: (parseInt(series_id)*1000 + i), title: it.name })) } });
    }

    res.json([]);
});

// YAYIN YÖNLENDİRİCİ
app.get('/:type/:user/:pass/:id', async (req, res) => {
    const { id } = req.params;
    const uniqueSeries = getAllUniqueSeries();
    const { streams: seriesStreams } = getSeriesAsLiveCategoriesAndStreams();
    
    let url = "";
    const cleanId = parseInt(id);

    if (cleanId < 1000) {
        url = cacheTV[cleanId - 1]?.url;
    } else if (cleanId >= 50000) {
        const found = seriesStreams.find(s => s.stream_id === cleanId);
        if (found) url = found.direct_source;
    } else {
        const sId = Math.floor(cleanId / 1000) - 1;
        const eId = (cleanId % 1000);
        url = uniqueSeries[sId]?.items[eId]?.url;
    }

    if (!url) return res.status(404).send("Bulunamadı");
    
    const finalUrl = url.includes("drive.usercontent") ? url : url.replace(/id=([a-zA-Z0-9_-]+)/, "https://drive.usercontent.google.com/download?id=$1&export=download&confirm=t");
    
    return res.redirect(302, finalUrl);
});

app.listen(PORT, () => console.log('Sunucu Önbellekli ve Kararlı Modda Başlatıldı.'));
