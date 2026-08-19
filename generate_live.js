const fs = require('fs');
const path = require('path');

const DEFAULT_PART_DURATION = 1200;

function turkishToEnglish(str) {
    return str
        .toLowerCase()
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ı/g, 'i')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/[^a-z0-9\s]/g, ' ')
        .trim();
}

function generateSmartAbbreviation(name, usedSlugs) {
    const clean = turkishToEnglish(name);
    const words = clean.split(/\s+/).filter(Boolean);

    if (words.length === 0) return "dizi";

    // Çok kelimeliyse (Örn: "Adventure Time" -> "at", "Kardeş Payı" -> "kp")
    if (words.length > 1) {
        let slug = words.map(w => w[0]).join('');
        if (!usedSlugs.has(slug)) return slug;

        for (let len = 2; len <= 5; len++) {
            slug = words.map(w => w.substring(0, len)).join('');
            if (!usedSlugs.has(slug)) return slug;
        }
    } 
    // Tek kelimeliyse (Örn: "Suskunlar" -> "su")
    else {
        const word = words[0];
        let slug = word.substring(0, 2);
        if (!usedSlugs.has(slug)) return slug;

        for (let len = 3; len <= word.length; len++) {
            slug = word.substring(0, len);
            if (!usedSlugs.has(slug)) return slug;
        }
    }

    let fallback = words.join('');
    let counter = 1;
    while (usedSlugs.has(fallback + (counter > 1 ? counter : ''))) {
        counter++;
    }
    return fallback + (counter > 1 ? counter : '');
}

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

                const nameKey = currentItem.seriesName.trim();
                if (!seriesMap.has(nameKey)) {
                    seriesMap.set(nameKey, {
                        name: nameKey,
                        parts: []
                    });
                }
                seriesMap.get(nameKey).parts.push({ ...currentItem });
                currentItem = {};
            }
        }
    });

    const outputDir = path.join(__dirname, 'live');
    
    // Eski dosyaları tamamen temizle
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const usedSlugs = new Set();

    seriesMap.forEach((data) => {
        const slug = generateSmartAbbreviation(data.name, usedSlugs);
        usedSlugs.add(slug);

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

        const outFilePath = path.join(outputDir, `${slug}.m3u8`);
        fs.writeFileSync(outFilePath, m3u8Content);
        console.log(`✅ [${data.name}] -> live/${slug}.m3u8`);
    });
}

generateLivePlaylists();
