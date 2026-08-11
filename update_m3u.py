import urllib.request
import re
import os
import base64

# Kaynak ve Hedef
SOURCE_ENCODED_URL = "https://forum.sinetech.tr/harici-link?to=aHR0cHM6Ly9tM3UuY2gvcGwvNTRmOGQ2MTc5ODZhNWMxOTdkZWVkYjYyOWRjYWE4MzhfN2ZkOGE5YmZmNzA0ZWVlNTAxYTk5MTRiMDc4MjVhMTQubTN1"
MY_M3U_FILE = "tv.m3u"

def get_real_url(redirect_url):
    """Yönlendirme linkindeki Base64 adresi çözer veya direkt adresi alır"""
    match = re.search(r'to=([^&]+)', redirect_url)
    if match:
        encoded_str = match.group(1)
        decoded_bytes = base64.b64decode(encoded_str)
        return decoded_bytes.decode('utf-8')
    return redirect_url

def parse_m3u(content):
    """M3U içeriğini kanal adı -> URL sözlüğü olarak ayrıştırır"""
    channels = {}
    lines = content.splitlines()
    current_name = None

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("#EXTINF:"):
            # tvg-name veya virgülden sonraki kanal adını al
            match = re.search(r'tvg-name="([^"]+)"', line)
            if match:
                current_name = match.group(1).strip()
            else:
                parts = line.split(',')
                if len(parts) > 1:
                    current_name = parts[-1].strip()
        elif not line.startswith("#") and current_name:
            channels[current_name] = line
            current_name = None

    return channels

def update_my_m3u():
    real_source_url = get_real_url(SOURCE_ENCODED_URL)
    print(f"Güncel M3U çekiliyor: {real_source_url}")

    # Güncel M3U'yu indir
    req = urllib.request.Request(real_source_url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as response:
            source_content = response.read().decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"Güncel M3U indirilemedi: {e}")
        return

    latest_channels = parse_m3u(source_content)
    print(f"Güncel M3U'dan {len(latest_channels)} kanal bilgisi okundu.")

    if not os.path.exists(MY_M3U_FILE):
        print(f"{MY_M3U_FILE} bulunamadı!")
        return

    with open(MY_M3U_FILE, 'r', encoding='utf-8', errors='ignore') as f:
        my_lines = f.readlines()

    updated_lines = []
    current_name = None
    updated_count = 0

    for line in my_lines:
        clean_line = line.strip()
        if clean_line.startswith("#EXTINF:"):
            match = re.search(r'tvg-name="([^"]+)"', clean_line)
            if match:
                current_name = match.group(1).strip()
            else:
                parts = clean_line.split(',')
                if len(parts) > 1:
                    current_name = parts[-1].strip()
            updated_lines.append(line)
        elif not clean_line.startswith("#") and clean_line != "" and current_name:
            # Eğer kanal güncel M3U'da varsa SADECE URL'sini değiştir
            if current_name in latest_channels:
                new_url = latest_channels[current_name]
                if new_url != clean_line:
                    updated_count += 1
                updated_lines.append(new_url + "\n")
            else:
                # Güncelde yoksa (senin özel eklediğin kanalsa) mevcut halini aynen koru
                updated_lines.append(line)
            current_name = None
        else:
            updated_lines.append(line)

    with open(MY_M3U_FILE, 'w', encoding='utf-8') as f:
        f.writelines(updated_lines)

    print(f"İşlem tamamlandı. Toplam {updated_count} kanalın linki güncellendi.")

if __name__ == "__main__":
    update_my_m3u()
