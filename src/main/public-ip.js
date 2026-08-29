// Beam public IP detection - tries multiple free APIs.
const TIMEOUT = 5000;

async function tryFetch(url, parse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return parse(text);
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function getPublicIp() {
  // Try ipify first (JSON)
  const ip = await tryFetch('https://api.ipify.org?format=json', (text) => {
    try { return JSON.parse(text).ip; } catch { return null; }
  });
  if (ip) return ip;

  // Fallback: icanhazip (plain text)
  const ip2 = await tryFetch('https://icanhazip.com', (text) => text.trim());
  if (ip2) return ip2;

  return null;
}
