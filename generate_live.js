const fs = require('fs');
const path = require('path');

const DEFAULT_PART_DURATION = 1200;

function generateLivePlaylists() {
    const seriesFilePath = path.join(__dirname, 'series.m3u');
    if (!fs.existsSync(seriesFilePath)) {
        console.error("series.m3u dosyası bulunamadı!");
        return;
    }

    const content = fs.readFileSync(seriesFilePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    const seriesMap = new Map();
    let currentItem = {};

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            const durationMatch = line.match(/#EXTINF:(-?\d+)/);
            let parsedDuration = durationMatch ? parseInt(durationMatch[1]) : -1;

            const groupMatch = line.match(/group-title="([^"]+)"/);
            const rawGroup = groupMatch ? groupMatch[1] : "Dizi";
            let seriesName = rawGroup.split('-')[0].trim();

            const titleParts = line.split(',');
            const rawTitle = titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : "Bölüm";

            let duration = DEFAULT_PART_DURATION;
            if (parsedDuration > 0) duration = parsedDuration;

            currentItem = { title: rawTitle, seriesName, duration };
        } else if (line && !line.startsWith('#')) {
            if (currentItem.seriesName) {
                let cleanUrl = line;
                const idMatch = line.match(/id=([a-zA-Z0-9_-]+)/);
                if (idMatch) {
                    cleanUrl = `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&confirm=t`;
                }
                currentItem.url = cleanUrl;

                const sKey = currentItem.seriesName.toLowerCase().replace(/[^a-z0-9]/g, '_');
                if (!seriesMap.has(sKey)) {
                    seriesMap.set(sKey, {
                        name: currentItem.seriesName,
                        parts: []
                    });
                }
                seriesMap.get(sKey).parts.push({ ...currentItem });
                currentItem = {};
            }
        }
    });

    const outputDir = path.join(__dirname, 'live');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    seriesMap.forEach((data, key) => {
        let m3u8Content = `#EXTM3U\n`;
        m3u8Content += `#EXT-X-VERSION:3\n`;
        m3u8Content += `#EXT-X-TARGETDURATION:7200\n`;
        m3u8Content += `#EXT-X-PLAYLIST-TYPE:VOD\n`;
        m3u8Content += `#EXT-X-MEDIA-SEQUENCE:0\n`;

        data.parts.forEach((part, i) => {
            if (i > 0) m3u8Content += `#EXT-X-DISCONTINUITY\n`;
            m3u8Content += `#EXTINF:${part.duration}.0, ${part.title}\n`;
            m3u8Content += `${part.url}\n`;
        });

        m3u8Content += `#EXT-X-ENDLIST\n`;

        const outFilePath = path.join(outputDir, `${key}.m3u8`);
        fs.writeFileSync(outFilePath, m3u8Content);
        console.log(`✅ [${data.name}] için canlı yayın dosyası hazır: live/${key}.m3u8`);
    });
}

generateLivePlaylists();
