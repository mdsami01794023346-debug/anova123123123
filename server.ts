import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import compression from 'compression';
import { createServer as createViteServer } from 'vite';
import { getOrFetch, db } from './server/cache.js';
import { GoogleGenAI, Type } from '@google/genai';
import { ref, get, set } from 'firebase/database';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Compress all responses using Gzip/Brotli to minimize origin payload sizes
  app.use(compression());

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Recursive helper to rewrite any image URLs in API responses to our Cloudflare-cached proxy
  function rewriteImageUrls(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      // Check if it's an image URL that should be proxied
      const isExternalImage = 
        (obj.startsWith('http://') || obj.startsWith('https://')) &&
        (obj.includes('unsplash.com') ||
         obj.includes('anilist.co') ||
         obj.includes('img.kryzox.xyz') ||
         obj.match(/\.(png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i));

      if (isExternalImage && !obj.includes('/api/image-proxy')) {
        return `/api/image-proxy?url=${encodeURIComponent(obj)}`;
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => rewriteImageUrls(item));
    }

    if (typeof obj === 'object') {
      const newObj: any = {};
      for (const key of Object.keys(obj)) {
        newObj[key] = rewriteImageUrls(obj[key]);
      }
      return newObj;
    }

    return obj;
  }

  // API proxy route for images to enable long-lived Cloudflare CDN Edge & Browser caching
  app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url as string;
    if (!imageUrl) {
      return res.status(400).send('Missing url parameter');
    }

    try {
      // Fetch image from origin
      const imageRes = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        }
      });

      if (!imageRes.ok) {
        throw new Error(`External server responded with status ${imageRes.status}`);
      }

      const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await imageRes.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);

      // Set long-lived cache headers for browser & Cloudflare Edge CDN (1 Year = 31536000s)
      res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=31536000');
      res.setHeader('CDN-Cache-Control', 'max-age=31536000');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.send(imageBuffer);
    } catch (err: any) {
      // Quietly redirect to high-quality fallback image on failure without noisy error logs
      const fallbackUrl = 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=300&auto=format&fit=crop&q=80';
      return res.redirect(fallbackUrl);
    }
  });

  // Resilient, rate-limit aware fetch function for Kryzox API with retries and exponential backoff
  async function fetchKryzoxWithRetry(url: string, retries = 3, delayMs = 1000): Promise<any> {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://api.kryzox.xyz/'
    };

    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, { headers });
        if (res.status === 429) {
          if (i < retries - 1) {
            console.warn(`[Kryzox Proxy Retry] URL ${url} returned 429. Retrying in ${delayMs}ms... (Attempt ${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            delayMs *= 2.5; // Exponential backoff with a larger multiplier for rate limits
            continue;
          }
          const err = new Error(`Kryzox API responded with status 429 (Too Many Requests)`);
          (err as any).status = 429;
          throw err;
        }

        if (!res.ok) {
          const err = new Error(`Kryzox API responded with status ${res.status}`);
          (err as any).status = res.status;
          throw err;
        }

        return await res.json();
      } catch (err: any) {
        if (i === retries - 1 || err.status === 429) {
          throw err;
        }
        console.warn(`[Kryzox Proxy Retry] Error fetching ${url}: ${err.message}. Retrying in ${delayMs}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
    }
  }

  // API proxy route for Kryzox API with advanced stale-while-revalidate caching
  app.get('/api/kryzox/*', async (req, res) => {
    try {
      const endpointPath = req.originalUrl.replace(/^\/api\/kryzox/, '');
      if (!endpointPath || endpointPath === '/') {
        return res.status(400).json({ error: 'Missing target endpoint' });
      }

      // Safeguard: Custom anime IDs do not exist on the external Kryzox API
      if (endpointPath.includes('custom-')) {
        if (endpointPath.includes('/episodes')) {
          return res.json({ success: true, data: [] });
        }
        return res.status(404).json({ success: false, error: 'Custom anime metadata not found on Kryzox API' });
      }

      const targetUrl = `https://api.kryzox.xyz${endpointPath}`;
      const cacheKey = `kryzox:${endpointPath}`;

      // Configurable Redis TTL of 24 hours (86400 seconds)
      const ttlSeconds = 24 * 60 * 60;
      // Stale threshold of 1 hour for normal metadata
      const staleThresholdMs = 1 * 60 * 60 * 1000;

      const data = await getOrFetch(
        cacheKey,
        async () => {
          return await fetchKryzoxWithRetry(targetUrl);
        },
        ttlSeconds,
        staleThresholdMs
      );

      // Enable robust Cloudflare Edge Caching
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=86400');
      res.setHeader('CDN-Cache-Control', 'max-age=86400');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.json(rewriteImageUrls(data));
    } catch (err: any) {
      const statusCode = err.status || 500;
      if (statusCode === 404) {
        console.warn(`[Kryzox Proxy Info] ${req.originalUrl}: Not found (404)`);
      } else {
        console.error(`[Kryzox Proxy Error] ${req.originalUrl}:`, err.message);
      }
      return res.status(statusCode).json({ error: err.message || 'Kryzox Proxy error' });
    }
  });

  // API proxy route for AnOvA backup Replit API with advanced stale-while-revalidate caching
  app.get('/api/anova/*', async (req, res) => {
    try {
      const endpointPath = req.originalUrl.replace(/^\/api\/anova/, '');
      if (!endpointPath || endpointPath === '/') {
        return res.status(400).json({ error: 'Missing target endpoint' });
      }

      const targetUrl = `https://backup--idplaypoinbdb.replit.app${endpointPath}`;
      const cacheKey = `anova_backup:${endpointPath}`;

      // Configurable Redis TTL of 24 hours (86400 seconds)
      const ttlSeconds = 24 * 60 * 60;
      // Stale threshold of 1 hour for normal metadata
      const staleThresholdMs = 1 * 60 * 60 * 1000;

      const data = await getOrFetch(
        cacheKey,
        async () => {
          const apiRes = await fetch(targetUrl);
          if (!apiRes.ok) {
            const err = new Error(`AnOvA backup API responded with status ${apiRes.status}`);
            (err as any).status = apiRes.status;
            throw err;
          }
          return await apiRes.json();
        },
        ttlSeconds,
        staleThresholdMs
      );

      // Enable robust Cloudflare Edge Caching
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=86400');
      res.setHeader('CDN-Cache-Control', 'max-age=86400');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.json(rewriteImageUrls(data));
    } catch (err: any) {
      const statusCode = err.status || 500;
      if (statusCode === 404) {
        console.warn(`[AnOvA Proxy Info] ${req.originalUrl}: Not found (404)`);
      } else {
        console.error(`[AnOvA Proxy Error] ${req.originalUrl}:`, err.message);
      }
      return res.status(statusCode).json({ error: err.message || 'AnOvA Proxy error' });
    }
  });

  // API Route to dynamically resolve AnOvA streams server-side to bypass CORS and DNS blockades with cache
  app.get('/api/resolve-anova-stream', async (req, res) => {
    try {
      const { id, season = '1', ep, isMovie, lang } = req.query;

      if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
      }

      const cacheKey = `anova_stream:${id}:S${season}:E${ep}:movie=${isMovie}:lang=${lang || ''}`;
      const ttlSeconds = 24 * 60 * 60; // 24 Hours Redis TTL
      const staleThresholdMs = 4 * 60 * 60 * 1000; // 4 Hours Stale threshold for media links

      const result = await getOrFetch(
        cacheKey,
        async () => {
          let streamApiUrl = '';
          if (isMovie === 'true' || !ep) {
            streamApiUrl = `https://backup--idplaypoinbdb.replit.app/api/movie?id=${encodeURIComponent(id as string)}`;
          } else {
            streamApiUrl = `https://backup--idplaypoinbdb.replit.app/api/stream?id=${encodeURIComponent(id as string)}&season=${season}&ep=${ep}`;
          }

          console.log(`[Resolver] Fetching stream info from AnOvA: ${streamApiUrl}`);
          const apiRes = await fetch(streamApiUrl);
          if (!apiRes.ok) {
            if (apiRes.status === 404) {
              console.warn(`[Resolver] Stream not found (404) for id ${id} from AnOvA API`);
              const err = new Error('Stream not found from AnOvA source');
              (err as any).status = 404;
              throw err;
            }
            const err = new Error(`AnOvA API responded with status ${apiRes.status}`);
            (err as any).status = apiRes.status;
            throw err;
          }

          const apiData = (await apiRes.json()) as any;
          const results = apiData.results || [];
          
          const validOptions = results.filter((r: any) => r && r.link);
          if (validOptions.length === 0) {
            const err = new Error('No valid options found in AnOvA API response');
            (err as any).status = 404;
            throw err;
          }

          let serverOption = null;

          // 1. Try language match if requested
          if (lang) {
            const langStr = String(lang).toLowerCase();
            serverOption = validOptions.find((r: any) => 
              r.language && r.language.toLowerCase() === langStr
            );
          }

          // 2. Fallback to server type options
          if (!serverOption) {
            serverOption = validOptions.find((r: any) => r.type === 'server') ||
                           validOptions.find((r: any) => r.type === 'stream') ||
                           validOptions[0];
          }

          const embedUrl = serverOption.link;
          console.log(`[Resolver] Selected option with link: ${embedUrl}`);

          let playableUrl = null;
          let videoData: any = {};

          try {
            // Attempt standard getVideo POST resolution if it looks like a standard stream domain
            if (embedUrl.includes('/video/') || embedUrl.includes('/player/index.php')) {
              const urlObj = new URL(embedUrl);
              const domain = urlObj.hostname;
              const videoId = urlObj.pathname.split('/').pop();

              if (videoId) {
                const postUrl = `https://${domain}/player/index.php?data=${videoId}&do=getVideo`;
                console.log(`[Resolver] Attempting getVideo POST: ${postUrl}`);

                const postBody = new URLSearchParams();
                postBody.append('hash', videoId);
                postBody.append('r', `https://${domain}/`);

                const videoRes = await fetch(postUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': `https://${domain}/video/${videoId}`
                  },
                  body: postBody.toString()
                });

                if (videoRes.ok) {
                  const videoText = await videoRes.text();
                  try {
                    videoData = JSON.parse(videoText);
                    playableUrl = videoData.securedLink || videoData.videoSource;
                  } catch (e) {
                    console.warn(`[Resolver] Failed to parse player server response as JSON, falling back to original embed`);
                  }
                }
              }
            }
          } catch (e: any) {
            console.warn(`[Resolver] Error during getVideo extraction, falling back to original embed link:`, e.message);
          }

          // Smart Fallback: if scraping direct source failed or was skipped, use the embed URL itself!
          if (!playableUrl) {
            console.log(`[Resolver] Direct source resolution skipped/failed. Falling back to original embed link: ${embedUrl}`);
            playableUrl = embedUrl;
          }

          console.log(`[Resolver] Resolved direct stream URL: ${playableUrl}`);
          return {
            success: true,
            url: playableUrl,
            image: videoData.videoImage || '',
            originalEmbed: embedUrl
          };
        },
        ttlSeconds,
        staleThresholdMs
      );

      // Enable robust Cloudflare Edge Caching
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=86400');
      res.setHeader('CDN-Cache-Control', 'max-age=86400');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.json(rewriteImageUrls(result));
    } catch (err: any) {
      const statusCode = err.status || 500;
      if (statusCode === 404) {
        console.warn('[Resolver Info] Stream not found (404) in resolve-anova-stream:', err.message);
      } else {
        console.error('[Resolver Error] Error in resolve-anova-stream:', err);
      }
      return res.status(statusCode).json({
        success: false,
        error: err.message || 'Unknown stream resolution error'
      });
    }
  });

  // API route for Anime ID mapping resolution (Redis -> Firebase -> API fallback)
  app.get('/api/anime-mapping/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Missing anime id' });
    }

    // Bypass external mapping lookup for custom-created anime IDs
    if (id.startsWith('custom-')) {
      return res.json({
        id,
        animoId: id,
        anilistId: '',
        malId: '',
        success: true
      });
    }

    try {
      const cacheKey = `anime-mapping:${id}`;
      // Map to 1 year TTL
      const ttlSeconds = 365 * 24 * 60 * 60;
      // Stale threshold is 30 days
      const staleThresholdMs = 30 * 24 * 60 * 60 * 1000;

      const mapping = await getOrFetch(
        cacheKey,
        async () => {
          // Fetch from Kryzox API /anime/:id to get mapping
          const targetUrl = `https://api.kryzox.xyz/anime/${id}`;
          console.log(`[Mapping Resolver] Fetching fresh mapping details for ID ${id} from: ${targetUrl}`);
          
          let animoId = id;
          let anilistId = '';
          let malId = '';

          try {
            const data = await fetchKryzoxWithRetry(targetUrl, 2, 800);
            const animeObj = data.data || data;
            if (animeObj) {
              animoId = String(animeObj.id || id);
              anilistId = String(animeObj.al_id || animeObj.anilist_id || animeObj.anilistId || animeObj.alId || '');
              malId = String(animeObj.mal_id || animeObj.malId || '');
            }
          } catch (apiErr: any) {
            console.error(`[Mapping Resolver] Kryzox API fetch failed for ID ${id}:`, apiErr.message);
          }

          // If mapping is still missing, scan episodes
          if (!anilistId || !malId || anilistId === 'null' || malId === 'null') {
            const episodesUrl = `https://api.kryzox.xyz/anime/${id}/episodes`;
            try {
              const epData = await fetchKryzoxWithRetry(episodesUrl, 2, 800);
              let epsList = [];
              if (Array.isArray(epData)) epsList = epData;
              else if (Array.isArray(epData?.data)) epsList = epData.data;
              else if (Array.isArray(epData?.episodes)) epsList = epData.episodes;

              for (const ep of epsList) {
                if (ep) {
                  const epAni = ep.ani || ep.anilistId || ep.anilist_id || ep.al_id || ep.alId;
                  const epMal = ep.mal || ep.malId || ep.mal_id;
                  if (!anilistId && epAni) {
                    const str = String(epAni);
                    anilistId = str.includes('/') ? str.split('/')[0] : str;
                  }
                  if (!malId && epMal) {
                    const str = String(epMal);
                    malId = str.includes('/') ? str.split('/')[0] : str;
                  }
                }
                if (anilistId && malId) break;
              }
            } catch (err: any) {
              console.warn(`[Mapping Resolver] Failed to fetch episodes for scanning:`, err.message);
            }
          }

          // Filter out invalid placeholders
          if (anilistId === 'null' || anilistId === 'undefined' || anilistId === '0') {
            anilistId = '';
          }
          if (malId === 'null' || malId === 'undefined' || malId === '0') {
            malId = '';
          }

          // If still missing and id is numeric, fallback to it
          const isNumeric = /^\d+$/.test(id);
          if (isNumeric) {
            if (!anilistId) {
              anilistId = id;
            }
            if (!malId) {
              malId = id;
            }
          }

          return { animoId, anilistId, malId };
        },
        ttlSeconds,
        staleThresholdMs
      );

      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.json(mapping);
    } catch (err: any) {
      console.error(`[Mapping Resolver Error] Failed to resolve mapping for ${id}:`, err);
      return res.status(500).json({ error: err.message || 'Mapping resolution failed' });
    }
  });

  // Server-side verification endpoint to get real status codes without CORS restrictions
  app.get('/api/verify-url', async (req, res) => {
    const urlStr = req.query.url as string;
    if (!urlStr) {
      return res.status(400).json({ error: 'Missing url' });
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500); // 4.5s timeout
      
      let response = null;
      try {
        response = await fetch(urlStr, {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://cdn.4animo.xyz/',
            'Accept': '*/*'
          },
          signal: controller.signal
        });
      } catch (headErr) {
        response = null;
      }
      clearTimeout(timeoutId);

      // If HEAD failed or is not allowed/blocked (status is not 2xx), fall back to GET with a short timeout and a Range/Abort limit
      if (!response || !response.ok || response.status === 405 || response.status === 403) {
        const getController = new AbortController();
        const getTimeoutId = setTimeout(() => getController.abort(), 3500);
        try {
          const getResponse = await fetch(urlStr, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://cdn.4animo.xyz/',
              'Range': 'bytes=0-1024',
              'Accept': '*/*'
            },
            signal: getController.signal
          });
          clearTimeout(getTimeoutId);
          response = getResponse;
        } catch (_) {
          clearTimeout(getTimeoutId);
        }
      }

      const finalStatus = response ? response.status : 0;
      // Consider successful if 2xx, or 416 (Range Satisfied), or 403 (Exists but direct curl forbidden, which is normal for CDNs and completely playable inside the browser iframe!)
      const success = response ? (response.ok || response.status === 416 || response.status === 403 || response.status === 302) : false;

      return res.json({
        success,
        status: finalStatus
      });
    } catch (err: any) {
      console.warn(`[Verify URL Error] Failed to verify ${urlStr}:`, err.message);
      return res.json({
        success: false,
        error: err.message
      });
    }
  });
  // Fetch YouTube Playlist items securely (with Scraper & Multi-Instance Invidious Proxy Fallback)
  app.get('/api/youtube-playlist', async (req, res) => {
    const { playlistUrl } = req.query;
    if (!playlistUrl || typeof playlistUrl !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing playlistUrl parameter' });
    }

    // Extract playlist ID from URL or use as-is
    let playlistId = playlistUrl.trim();
    if (playlistUrl.includes('list=')) {
      const match = playlistUrl.match(/[&?]list=([^&]+)/);
      if (match && match[1]) {
        playlistId = match[1];
      }
    }

    // Helper to scrape public YouTube playlist page (Last-Resort Fallback)
    const fetchPlaylistPage = async (pid: string): Promise<any[]> => {
      const url = `https://www.youtube.com/playlist?list=${pid}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });

      if (!response.ok) {
        throw new Error(`YouTube returned status ${response.status} when scraping playlist.`);
      }

      const html = await response.text();

      // Extract ytInitialData object
      let jsonStr = '';
      const regexes = [
        /ytInitialData\s*=\s*({[\s\S]+?});\s*(?:<\/script>|window|var)/,
        /ytInitialData\s*=\s*({[\s\S]+?});/,
        /var ytInitialData\s*=\s*([\s\S]+?);<\/script>/,
        /window\["ytInitialData"\]\s*=\s*([\s\S]+?);/,
        /ytInitialData\s*=\s*({[\s\S]+?})\s*;/
      ];

      for (const regex of regexes) {
        const match = html.match(regex);
        if (match && match[1]) {
          jsonStr = match[1].trim();
          break;
        }
      }

      // Advanced brace counter fallback in case regexes failed
      if (!jsonStr) {
        const index = html.indexOf('ytInitialData = ');
        if (index !== -1) {
          const startIdx = html.indexOf('{', index);
          if (startIdx !== -1) {
            let braceCount = 0;
            let endIdx = -1;
            for (let i = startIdx; i < html.length; i++) {
              const char = html[i];
              if (char === '{') {
                braceCount++;
              } else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  endIdx = i;
                  break;
                }
              }
            }
            if (endIdx !== -1) {
              jsonStr = html.substring(startIdx, endIdx + 1);
            }
          }
        }
      }

      if (!jsonStr) {
        throw new Error('Could not find playlist data (ytInitialData) in YouTube response. Make sure the playlist is public.');
      }

      let data: any;
      try {
        data = JSON.parse(jsonStr);
      } catch (err) {
        throw new Error('Failed to parse YouTube playlist data.');
      }

      // Find all playlistVideoRenderer instances recursively
      const renderers: any[] = [];
      const recurse = (current: any) => {
        if (!current || typeof current !== 'object') return;
        if (current.playlistVideoRenderer) {
          renderers.push(current.playlistVideoRenderer);
          return;
        }
        if (Array.isArray(current)) {
          for (const item of current) {
            recurse(item);
          }
        } else {
          for (const key of Object.keys(current)) {
            recurse(current[key]);
          }
        }
      };

      recurse(data);

      if (renderers.length === 0) {
        throw new Error('No videos found in YouTube playlist. Make sure the playlist is public and contains videos.');
      }

      // Map renderers to our unified structure
      return renderers.map((video: any) => {
        const videoId = video.videoId || '';
        
        // Extract title safely
        let title = '';
        if (video.title) {
          if (video.title.runs && video.title.runs[0]) {
            title = video.title.runs[0].text || '';
          } else if (video.title.simpleText) {
            title = video.title.simpleText || '';
          }
        }

        // Extract thumbnail safely (select highest quality)
        let thumbnail = '';
        const thumbs = video.thumbnail?.thumbnails || [];
        if (thumbs.length > 0) {
          const highest = thumbs.reduce((prev: any, curr: any) => {
            return (prev.width || 0) > (curr.width || 0) ? prev : curr;
          });
          thumbnail = highest.url || '';
        }

        const lowerTitle = title.toLowerCase();
        const isPrivateOrDeleted = 
          video.isPlayable === false || 
          lowerTitle.includes('deleted video') || 
          lowerTitle.includes('private video');

        return {
          videoId,
          title,
          thumbnail,
          url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
          isPrivateOrDeleted
        };
      });
    };

    // Helper to fetch playlist items from public Invidious instances to bypass Google IP rate limiting
    const fetchPlaylistViaInvidious = async (pid: string): Promise<any[]> => {
      let activeDomains: string[] = [];

      try {
        console.log('[YouTube Playlist] Querying active Invidious list...');
        const res = await fetch('https://api.invidious.io/instances.json', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const instances = await res.json();
          if (Array.isArray(instances)) {
            activeDomains = instances
              .filter(([domain, details]) => details.type === 'https' && details.monitor && details.monitor.down === false)
              .map(([domain]) => domain);
          }
        }
      } catch (err: any) {
        console.log('[YouTube Playlist] Dynamic list lookup bypassed, switching to fallbacks');
      }

      // Fallback hardcoded list of stable active Invidious instances
      const fallbackDomains = [
        'yewtu.be',
        'invidious.privacydev.net',
        'invidious.nerdvpn.de',
        'invidious.projectsegfaut.im',
        'invidious.lunar.icu',
        'invidio.xamh.de',
        'yt.artemislena.eu',
        'inv.git.fm',
        'inv.nadeko.net'
      ];

      // Merge dynamic and fallback domains, preserving unique values
      const domainsToTry = Array.from(new Set([...activeDomains, ...fallbackDomains])).slice(0, 8);

      for (const domain of domainsToTry) {
        console.log(`[YouTube Playlist] Trying Invidious proxy instance: ${domain}...`);
        try {
          let allVideos: any[] = [];
          let page = 1;
          let hasMore = true;
          const maxPages = 30; // support up to 3000 videos

          while (hasMore && page <= maxPages) {
            const url = `https://${domain}/api/v1/playlists/${pid}?page=${page}`;
            console.log(`[YouTube Playlist] Fetching page ${page} from ${domain}...`);
            const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
            
            if (!response.ok) {
              if (page === 1) {
                throw new Error(`Invidious instance returned status ${response.status} on page 1`);
              } else {
                console.log(`[YouTube Playlist] Invidious instance ${domain} returned status ${response.status} on page ${page}. Stopping page fetch.`);
                break;
              }
            }

            const contentType = response.headers.get('content-type') || '';
            if (contentType && !contentType.includes('application/json')) {
              throw new Error(`Instance returned non-JSON content-type: ${contentType}`);
            }

            const text = await response.text();
            if (!text || text.trim().startsWith('<') || text.trim().startsWith('<!DOCTYPE')) {
              throw new Error('Instance returned HTML page/blocker instead of JSON data');
            }

            let data: any;
            try {
              data = JSON.parse(text);
            } catch (parseErr) {
              throw new Error('Failed to parse response body as JSON');
            }

            if (data && data.videos && Array.isArray(data.videos) && data.videos.length > 0) {
              allVideos = allVideos.concat(data.videos);
              console.log(`[YouTube Playlist] Retrieved ${data.videos.length} videos from page ${page} of ${domain}. Total: ${allVideos.length}`);
              page++;
              if (data.videos.length < 10) {
                hasMore = false;
              }
            } else {
              hasMore = false;
            }
          }

          if (allVideos.length > 0) {
            console.log(`[YouTube Playlist] Successfully retrieved ${allVideos.length} videos in total from ${domain}!`);
            return allVideos.map((video: any) => {
              const videoId = video.videoId || '';
              const title = video.title || '';
              const thumbs = video.videoThumbnails || [];
              
              let thumbnail = '';
              if (thumbs.length > 0) {
                const highest = thumbs.reduce((prev: any, curr: any) => {
                  return (prev.width || 0) > (curr.width || 0) ? prev : curr;
                });
                thumbnail = highest.url || thumbs[0].url || '';
              } else {
                thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
              }

              return {
                videoId,
                title,
                thumbnail,
                url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
                isPrivateOrDeleted: false
              };
            });
          }
        } catch (err: any) {
          console.log(`[YouTube Playlist] Note: Instance ${domain} skipped (offline)`);
        }
      }

      throw new Error('All proxy instances completed attempt sequence.');
    };

    const apiKey = process.env.YOUTUBE_API_KEY;
    // Note: AI Studio / Gemini API keys (starting with 'AQ.') are not valid for the Google YouTube API.
    const isApiKeyConfigured = apiKey && 
      apiKey !== 'YOUR_YOUTUBE_API_KEY' && 
      !apiKey.startsWith('YOUR_') && 
      !apiKey.startsWith('AQ.');

    if (isApiKeyConfigured) {
      try {
        console.log('[YouTube Playlist] Attempting fetch via official API with configured credentials...');
        let items: any[] = [];
        let nextPageToken = '';
        let pagesFetched = 0;
        const maxPages = 30; // Fetch up to 1500 videos

        // Detect if the key starts with 'AIzaSy' (standard Google API Key) or is an OAuth2/Bearer token
        const isStandardApiKey = apiKey.startsWith('AIzaSy');
        const headers: Record<string, string> = {
          'Accept': 'application/json'
        };
        if (!isStandardApiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        do {
          let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,status&playlistId=${playlistId}&maxResults=50`;

          if (isStandardApiKey) {
            url += `&key=${apiKey}`;
          }

          if (nextPageToken) {
            url += `&pageToken=${nextPageToken}`;
          }

          const response = await fetch(url, { headers });
          
          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData?.error?.message || `YouTube API responded with status ${response.status}`;
            throw new Error(errMsg);
          }

          const data = await response.json();
          if (data.items) {
            items = items.concat(data.items);
          }
          nextPageToken = data.nextPageToken || '';
          pagesFetched++;
        } while (nextPageToken && pagesFetched < maxPages);

        // Process and filter items
        const processedItems = items.map((item: any) => {
          const snippet = item.snippet || {};
          const status = item.status || {};
          const title = snippet.title || '';
          const videoId = snippet.resourceId?.videoId || '';
          const isPrivateOrDeleted = 
            status.privacyStatus === 'private' || 
            title.toLowerCase() === 'deleted video' || 
            title.toLowerCase() === 'private video';

          // Select the highest available quality thumbnail
          const thumbs = snippet.thumbnails || {};
          const thumbnail = 
            thumbs.maxres?.url || 
            thumbs.standard?.url || 
            thumbs.high?.url || 
            thumbs.medium?.url || 
            thumbs.default?.url || 
            '';

          return {
            videoId,
            title,
            thumbnail,
            url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
            isPrivateOrDeleted
          };
        });

        return res.json({
          success: true,
          playlistId,
          items: processedItems,
          source: 'api'
        });
      } catch (apiError: any) {
        console.log('[YouTube Playlist] Official API did not succeed, falling back to Invidious proxies/scraping. Error details:', apiError.message);
      }
    }

    // Try Invidious proxy instances first (to bypass Google Cloud Run CAPTCHA on standard YouTube)
    try {
      const processedItems = await fetchPlaylistViaInvidious(playlistId);
      return res.json({
        success: true,
        playlistId,
        items: processedItems,
        source: 'invidious_proxy'
      });
    } catch (invidiousError: any) {
      console.log('[YouTube Playlist] Proxy sequence ended, trying backup scraper');
    }

    // Last-resort fallback to public page scraper
    try {
      console.log('[YouTube Playlist] Retrieving via scraper backup...');
      const processedItems = await fetchPlaylistPage(playlistId);
      return res.json({
        success: true,
        playlistId,
        items: processedItems,
        source: 'scraper'
      });
    } catch (scrapeError: any) {
      console.log('[YouTube Playlist] Scraper sequence finished');
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve YouTube playlist content.'
      });
    }
  });

  // Fetch YouTube Channel Playlists securely (with Scraper & Invidious Proxy Fallback)
  app.get('/api/youtube-channel-playlists', async (req, res) => {
    const { channelUrl } = req.query;
    if (!channelUrl || typeof channelUrl !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing channelUrl parameter' });
    }

    // Helper to extract channelId from URL/username
    const getChannelId = async (input: string): Promise<string> => {
      const trimmed = input.trim();
      
      // 1. Direct channel ID check
      if (/^UC[a-zA-Z0-9_-]{22}$/.test(trimmed)) {
        return trimmed;
      }
      
      // If it's a URL, let's try to extract if it already has the channel ID
      const directIdMatch = trimmed.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/i);
      if (directIdMatch && directIdMatch[1]) {
        return directIdMatch[1];
      }

      // Extract handle or name
      let query = trimmed;
      if (trimmed.includes('youtube.com/') || trimmed.includes('youtu.be/')) {
        // e.g. https://www.youtube.com/@MuseAsia
        const handleMatch = trimmed.match(/\/@([a-zA-Z0-9_-]+)/i);
        if (handleMatch && handleMatch[1]) {
          query = `@${handleMatch[1]}`;
        } else {
          // e.g. https://www.youtube.com/c/SomeName or /user/SomeName
          const pathMatch = trimmed.match(/\/(?:c|user)\/([a-zA-Z0-9_-]+)/i);
          if (pathMatch && pathMatch[1]) {
            query = pathMatch[1];
          } else {
            // Last resort: extract last segment
            const parts = trimmed.split('/');
            const last = parts[parts.length - 1];
            if (last) query = last;
          }
        }
      }

      if (!query.startsWith('@') && !trimmed.includes('/') && trimmed.length > 0) {
        query = `@${query}`;
      }

      console.log(`[getChannelId] Parsed query: "${query}" from input: "${trimmed}"`);

      // Try resolving using Invidious search first to bypass YouTube scrap blocking
      let activeDomains: string[] = [];
      try {
        const res = await fetch('https://api.invidious.io/instances.json', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const instances = await res.json();
          if (Array.isArray(instances)) {
            activeDomains = instances
              .filter(([domain, details]) => details.type === 'https' && details.monitor && details.monitor.down === false)
              .map(([domain]) => domain);
          }
        }
      } catch (err) {}

      const fallbackDomains = [
        'yewtu.be',
        'invidious.privacydev.net',
        'invidious.nerdvpn.de',
        'invidious.projectsegfaut.im',
        'invidious.lunar.icu',
        'invidio.xamh.de',
        'yt.artemislena.eu',
        'inv.git.fm',
        'inv.nadeko.net'
      ];
      const domainsToTry = Array.from(new Set([...activeDomains, ...fallbackDomains])).slice(0, 8);

      for (const domain of domainsToTry) {
        try {
          // Search for channel with type=channel
          const searchUrl = `https://${domain}/api/v1/search?q=${encodeURIComponent(query)}&type=channel`;
          console.log(`[getChannelId] Trying Invidious resolve on: ${domain}`);
          const response = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
          if (response.ok) {
            const results = await response.json();
            if (Array.isArray(results) && results.length > 0) {
              const matchedChannel = results.find((c: any) => 
                c.type === 'channel' && 
                (c.authorId || c.channelId)
              );
              const cid = matchedChannel ? (matchedChannel.authorId || matchedChannel.channelId) : null;
              if (cid && /^UC[a-zA-Z0-9_-]{22}$/.test(cid)) {
                console.log(`[getChannelId] Resolved channel ID: ${cid} via ${domain}`);
                return cid;
              }
            }
          }
        } catch (err) {
          console.log(`[getChannelId] Invidious domain ${domain} search failed:`, err);
        }
      }

      // If Invidious search fails, let's try direct handle scraping from Invidious instances instead of youtube.com!
      for (const domain of domainsToTry) {
        try {
          const directUrl = `https://${domain}/${query}`;
          console.log(`[getChannelId] Trying direct scraper on Invidious domain: ${domain}`);
          const response = await fetch(directUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(5000)
          });
          if (response.ok) {
            const html = await response.text();
            const cidMatch = html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
            if (cidMatch && cidMatch[1]) {
              console.log(`[getChannelId] Resolved channel ID: ${cidMatch[1]} via Invidious page scraper on ${domain}`);
              return cidMatch[1];
            }
          }
        } catch (err) {
          console.log(`[getChannelId] Direct scraper failed on ${domain}:`, err);
        }
      }

      // Absolute last resort: try YouTube scraper (which may 404/403 but is our ultimate fallback)
      console.log(`[getChannelId] Invidious resolutions failed. Falling back to YouTube direct scrape...`);
      let youtubeUrl = trimmed;
      if (!youtubeUrl.startsWith('http')) {
        if (youtubeUrl.startsWith('@')) {
          youtubeUrl = `https://www.youtube.com/${youtubeUrl}`;
        } else {
          youtubeUrl = `https://www.youtube.com/@${youtubeUrl}`;
        }
      }
      
      const response = await fetch(youtubeUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch channel page: status ${response.status}. Please try again or paste the direct Channel ID (starting with UC).`);
      }
      
      const html = await response.text();
      const metaMatch = html.match(/<meta\s+itemprop="channelId"\s+content="(UC[a-zA-Z0-9_-]{22})"/);
      if (metaMatch && metaMatch[1]) return metaMatch[1];
      
      const jsonMatch = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
      if (jsonMatch && jsonMatch[1]) return jsonMatch[1];

      const browseMatch = html.match(/"browseId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
      if (browseMatch && browseMatch[1]) return browseMatch[1];
      
      throw new Error('Could not resolve YouTube Channel ID from URL/Handle. Please enter the direct Channel ID (starts with UC).');
    };

    // Helper to scrape channel playlists page
    const fetchChannelPlaylistsPage = async (cid: string): Promise<any[]> => {
      const url = `https://www.youtube.com/channel/${cid}/playlists`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });

      if (!response.ok) {
        throw new Error(`YouTube returned status ${response.status} when scraping channel playlists.`);
      }

      const html = await response.text();
      let jsonStr = '';
      const regexes = [
        /ytInitialData\s*=\s*({[\s\S]+?});\s*(?:<\/script>|window|var)/,
        /ytInitialData\s*=\s*({[\s\S]+?});/,
        /var ytInitialData\s*=\s*([\s\S]+?);<\/script>/,
        /window\["ytInitialData"\]\s*=\s*([\s\S]+?);/,
        /ytInitialData\s*=\s*({[\s\S]+?})\s*;/
      ];

      for (const regex of regexes) {
        const match = html.match(regex);
        if (match && match[1]) {
          jsonStr = match[1].trim();
          break;
        }
      }

      if (!jsonStr) {
        const index = html.indexOf('ytInitialData = ');
        if (index !== -1) {
          const startIdx = html.indexOf('{', index);
          if (startIdx !== -1) {
            let braceCount = 0;
            let endIdx = -1;
            for (let i = startIdx; i < html.length; i++) {
              const char = html[i];
              if (char === '{') {
                braceCount++;
              } else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  endIdx = i;
                  break;
                }
              }
            }
            if (endIdx !== -1) {
              jsonStr = html.substring(startIdx, endIdx + 1);
            }
          }
        }
      }

      if (!jsonStr) {
        throw new Error('Could not find channel playlists data (ytInitialData) in response.');
      }

      const data = JSON.parse(jsonStr);
      const playlists: any[] = [];
      const seenIds = new Set<string>();

      const recurse = (current: any) => {
        if (!current || typeof current !== 'object') return;
        
        if (current.playlistId && (current.title || current.thumbnail)) {
          const pid = current.playlistId;
          if (!seenIds.has(pid)) {
            seenIds.add(pid);
            let title = '';
            if (current.title) {
              if (current.title.runs && current.title.runs[0]) {
                title = current.title.runs[0].text;
              } else if (current.title.simpleText) {
                title = current.title.simpleText;
              }
            }
            
            let thumbnail = '';
            const thumbs = current.thumbnail?.thumbnails || [];
            if (thumbs.length > 0) {
              thumbnail = thumbs[thumbs.length - 1].url || '';
            }
            
            let videoCount = 0;
            if (current.videoCountText) {
              const text = current.videoCountText.runs?.[0]?.text || current.videoCountText.simpleText || '';
              const match = text.match(/\d+/);
              if (match) videoCount = parseInt(match[0], 10);
            } else if (current.videoCount) {
              videoCount = parseInt(current.videoCount, 10) || 0;
            }

            playlists.push({
              playlistId: pid,
              title: title || 'Untitled Playlist',
              playlistThumbnail: thumbnail || `https://img.youtube.com/vi/none/hqdefault.jpg`,
              videoCount,
              description: ''
            });
          }
          return;
        }

        if (Array.isArray(current)) {
          for (const item of current) {
            recurse(item);
          }
        } else {
          for (const key of Object.keys(current)) {
            recurse(current[key]);
          }
        }
      };

      recurse(data);
      return playlists;
    };

    // Helper to fetch via Invidious
    const fetchChannelPlaylistsViaInvidious = async (cid: string): Promise<any[]> => {
      let activeDomains: string[] = [];
      try {
        const res = await fetch('https://api.invidious.io/instances.json', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const instances = await res.json();
          if (Array.isArray(instances)) {
            activeDomains = instances
              .filter(([domain, details]) => details.type === 'https' && details.monitor && details.monitor.down === false)
              .map(([domain]) => domain);
          }
        }
      } catch (err) {}

      const fallbackDomains = [
        'yewtu.be',
        'invidious.privacydev.net',
        'invidious.nerdvpn.de',
        'invidious.projectsegfaut.im',
        'invidious.lunar.icu',
        'invidio.xamh.de',
        'yt.artemislena.eu',
        'inv.git.fm',
        'inv.nadeko.net'
      ];
      const domainsToTry = Array.from(new Set([...activeDomains, ...fallbackDomains])).slice(0, 8);

      for (const domain of domainsToTry) {
        try {
          const url = `https://${domain}/api/v1/channels/${cid}/playlists`;
          const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (response.ok) {
            const data = await response.json();
            const playlists = data.playlists || data;
            if (Array.isArray(playlists)) {
              return playlists.map((pl: any) => ({
                playlistId: pl.playlistId,
                title: pl.title || 'Untitled Playlist',
                playlistThumbnail: pl.playlistThumbnail || (pl.videos?.[0]?.videoId ? `https://img.youtube.com/vi/${pl.videos[0].videoId}/hqdefault.jpg` : ''),
                videoCount: pl.videoCount || 0,
                description: pl.description || ''
              }));
            }
          }
        } catch (err) {}
      }
      throw new Error('All Invidious instances failed.');
    };

    try {
      const channelId = await getChannelId(channelUrl);
      console.log(`[YouTube Channel] Resolved channelId: ${channelId}`);

      // Try Invidious first
      try {
        const playlists = await fetchChannelPlaylistsViaInvidious(channelId);
        return res.json({ success: true, channelId, playlists, source: 'invidious' });
      } catch (err) {
        console.log('[YouTube Channel] Invidious failed, trying scraper...');
      }

      // Fallback to scraper
      const playlists = await fetchChannelPlaylistsPage(channelId);
      return res.json({ success: true, channelId, playlists, source: 'scraper' });

    } catch (error: any) {
      console.error('[YouTube Channel Error]:', error);
      return res.status(500).json({ success: false, error: error.message || 'Failed to fetch channel playlists' });
    }
  });

  // Universal Web Scraping and AI parsing endpoint
  app.post('/api/scrape-web-page', async (req, res) => {
    const { url, html: clientProvidedHtml } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }
    try {
      const parsedUrl = new URL(normalizedUrl);
      if (parsedUrl.hostname.toLowerCase() === 'watchanimeworld') {
        parsedUrl.hostname = 'watchanimeworld.net';
        normalizedUrl = parsedUrl.toString();
      }
    } catch (_) {}

    try {
      const isCloudflareBlocked = (text: string): boolean => {
        if (!text) return false;
        const lowercase = text.toLowerCase();
        return (
          lowercase.includes('security verification/captcha') ||
          lowercase.includes('cloudflare') ||
          lowercase.includes('captcha') ||
          lowercase.includes('verify you are a human') ||
          lowercase.includes('checking your browser') ||
          lowercase.includes('ddos protection') ||
          lowercase.includes('js-challenger') ||
          lowercase.includes('access denied') ||
          lowercase.includes('enable javascript') ||
          lowercase.includes('security system') ||
          lowercase.includes('blocked')
        );
      };

      let rawHtml = '';
      if (clientProvidedHtml && clientProvidedHtml.trim().length > 100) {
        console.log(`[Universal Scraper] Using direct client-provided HTML for URL: "${normalizedUrl}"`);
        rawHtml = clientProvidedHtml;
      } else {
        console.log(`[Universal Scraper] Scraping page: "${normalizedUrl}"`);
        let lastErrorMsg = '';

        // Try 1: Jina Reader API (extremely reliable free web reader that bypasses Cloudflare and security blocks effortlessly)
        try {
          console.log('[Universal Scraper] Attempting Jina Reader API Cloudflare Bypass...');
          const jinaUrl = `https://r.jina.ai/${encodeURIComponent(normalizedUrl)}`;
          const response = await fetch(jinaUrl, {
            headers: {
              'Accept': 'text/html',
              'X-No-Cache': 'true'
            },
            signal: AbortSignal.timeout(12000)
          });
          if (response.ok) {
            const text = await response.text();
            if (text && text.trim().length > 300) {
              if (isCloudflareBlocked(text)) {
                console.warn('[Universal Scraper] Jina Reader returned a Cloudflare/CAPTCHA block page. Invalidating response...');
                lastErrorMsg = 'Jina Reader returned a Cloudflare block page';
              } else {
                rawHtml = text;
                console.log('[Universal Scraper] Jina Reader API Succeeded!');
              }
            } else {
              lastErrorMsg = 'Jina Reader returned empty content';
            }
          } else {
            lastErrorMsg = `Jina Reader status ${response.status}`;
          }
        } catch (e: any) {
          lastErrorMsg = `Jina Reader failed: ${e.message || e}`;
        }

        // Try 2: Direct fetch with headers
        if (!rawHtml || rawHtml.trim().length < 300) {
          try {
            console.log('[Universal Scraper] Attempting Direct Fetch...');
            const response = await fetch(normalizedUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
              },
              signal: AbortSignal.timeout(8000)
            });
            if (response.ok) {
              const text = await response.text();
              if (isCloudflareBlocked(text)) {
                console.warn('[Universal Scraper] Direct Fetch returned a Cloudflare/CAPTCHA block page. Invalidating...');
                lastErrorMsg += ' | Direct Fetch returned a Cloudflare block page';
              } else {
                rawHtml = text;
                console.log('[Universal Scraper] Direct Fetch Succeeded!');
              }
            } else {
              lastErrorMsg += ` | Direct Fetch status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | Direct Fetch failed: ${e.message || e}`;
          }
        }

        // Try 3: AllOrigins proxy fallback (very reliable CORS proxy)
        if (!rawHtml || rawHtml.trim().length < 150) {
          try {
            console.log('[Universal Scraper] Direct Fetch blocked or failed. Attempting AllOrigins Proxy Fallback...');
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(normalizedUrl)}`;
            const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const text = await response.text();
              if (text && text.trim().length > 150) {
                if (isCloudflareBlocked(text)) {
                  console.warn('[Universal Scraper] AllOrigins returned a Cloudflare/CAPTCHA block page. Invalidating...');
                  lastErrorMsg += ' | AllOrigins returned a Cloudflare block page';
                } else {
                  rawHtml = text;
                  console.log('[Universal Scraper] AllOrigins Proxy Fetch Succeeded!');
                }
              } else {
                lastErrorMsg += ' | AllOrigins returned empty/too small response';
              }
            } else {
              lastErrorMsg += ` | AllOrigins status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | AllOrigins failed: ${e.message || e}`;
          }
        }

        // Try 4: CORSProxy.io fallback
        if (!rawHtml || rawHtml.trim().length < 150) {
          try {
            console.log('[Universal Scraper] Attempting CORSProxy.io Fallback...');
            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(normalizedUrl)}`;
            const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const text = await response.text();
              if (text && text.trim().length > 150) {
                if (isCloudflareBlocked(text)) {
                  console.warn('[Universal Scraper] CORSProxy.io returned a Cloudflare/CAPTCHA block page. Invalidating...');
                  lastErrorMsg += ' | CORSProxy.io returned a Cloudflare block page';
                } else {
                  rawHtml = text;
                  console.log('[Universal Scraper] CORSProxy.io Succeeded!');
                }
              } else {
                lastErrorMsg += ' | CORSProxy returned empty/too small response';
              }
            } else {
              lastErrorMsg += ` | CORSProxy status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | CORSProxy failed: ${e.message || e}`;
          }
        }

        // Try 5: CodeTabs proxy fallback
        if (!rawHtml || rawHtml.trim().length < 150) {
          try {
            console.log('[Universal Scraper] Attempting CodeTabs Proxy Fallback...');
            const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(normalizedUrl)}`;
            const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const text = await response.text();
              if (text && text.trim().length > 150) {
                if (isCloudflareBlocked(text)) {
                  console.warn('[Universal Scraper] CodeTabs returned a Cloudflare/CAPTCHA block page. Invalidating...');
                  lastErrorMsg += ' | CodeTabs returned a Cloudflare block page';
                } else {
                  rawHtml = text;
                  console.log('[Universal Scraper] CodeTabs Proxy Succeeded!');
                }
              } else {
                lastErrorMsg += ' | CodeTabs returned empty/too small response';
              }
            } else {
              lastErrorMsg += ` | CodeTabs status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | CodeTabs failed: ${e.message || e}`;
          }
        }
      }

      const ai = getAI();

      // If all scrapers failed to yield content, fall back to Google Search Grounding to extract the info directly from the web!
      if (!rawHtml || rawHtml.trim().length < 150) {
        console.log('[Universal Scraper] Every scraping proxy failed. Falling back to Gemini Google Search Grounding...');
        const searchPrompt = `You are a professional Anime/Movie Website Scraping Assistant.
We tried to scrape the webpage "${normalizedUrl}" but were blocked by security protections.
Please search Google for the details and episodes of the anime show listed at or matching the URL "${normalizedUrl}".
Identify if this page represents a single anime series or a catalog page of multiple anime shows.

Return ONLY a JSON object with one of these structures depending on the page type:

1. IF it represents a single anime show, return:
{
  "pageType": "single",
  "title": "Title of the series/movie in English or Romaji",
  "description": "Short synopsis or description. Try to find the exact summary.",
  "coverImage": "The URL of the poster, thumbnail, or banner image for the show",
  "releaseYear": "The release year or airing year (e.g. 2024)",
  "genres": ["Genre1", "Genre2"],
  "type": "TV" or "Movie" or "OVA" or "ONA" or "Special",
  "episodes": [
    {
      "episodeNumber": 1,
      "title": "Episode title (e.g., 'Episode 1' or 'The Beginning')",
      "url": "The full watch page URL or embed stream link on this website"
    }
  ]
}

2. IF it is a homepage, directory, catalog, list of multiple shows, or search page on this website, return:
{
  "pageType": "catalog",
  "shows": [
    {
      "title": "Anime Show Title",
      "url": "The full specific watch/series URL on this website (e.g., https://watchanimeworld.net/series/blue-box-sub)",
      "coverImage": "The poster or image URL of this show",
      "description": "Short status snippet (e.g., 'Completed', 'Ongoing', '12 Episodes')"
    }
  ]
}

Ensure all URLs are absolute. Sort episodes in ascending order by episodeNumber.
Return ONLY the structured JSON. Do not wrap in markdown \`\`\`json blocks. Do not add any extra text.`;

        const genRes = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: searchPrompt,
          config: {
            responseMimeType: 'application/json',
            tools: [{ googleSearch: {} }]
          }
        });

        const resultText = genRes.text.trim();
        let parsedData: any = {};
        try {
          parsedData = JSON.parse(resultText);
        } catch (jsonErr) {
          const cleanedText = resultText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
          parsedData = JSON.parse(cleanedText);
        }

        if (parsedData && (parsedData.title || (parsedData.shows && parsedData.shows.length > 0))) {
          return res.json({ success: true, data: parsedData });
        } else {
          throw new Error('Google Search Grounding could not find sufficient details.');
        }
      }
      
      // Clean up HTML to stay within reasonable token sizes and remove noise
      let html = rawHtml;
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
      html = html.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
      html = html.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
      html = html.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '');
      html = html.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');
      html = html.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
      
      // Keep only first 150k chars of HTML to be safe
      const cleanedHtml = html.slice(0, 150000);

      const prompt = `You are a professional Anime/Movie Website Scraping Assistant.
Analyze the following HTML from a streaming website (like watchanimeworld.net, themoviebox.xyz, or similar).
Determine if this page contains a single Anime/Movie/Series detail page, or if it is a directory/homepage/catalog/search-results page containing multiple different anime shows.

Target Website URL: ${normalizedUrl}

HTML Content:
${cleanedHtml}

Return ONLY a JSON object with one of these structures depending on the page type:

1. IF it is a single anime show page (has episodes list for this show), return:
{
  "pageType": "single",
  "title": "Title of the series/movie in English or Romaji",
  "description": "Short synopsis or description. Try to find the exact summary.",
  "coverImage": "The URL of the poster, thumbnail, or banner image for the show",
  "releaseYear": "The release year or airing year (e.g. 2024)",
  "genres": ["Genre1", "Genre2"],
  "type": "TV" or "Movie" or "OVA" or "ONA" or "Special",
  "episodes": [
    {
      "episodeNumber": 1,
      "title": "Episode title (e.g., 'Episode 1' or 'The Beginning')",
      "url": "The full or relative URL of the episode watch page, embed source, or play link"
    }
  ]
}

2. IF it is a catalog/directory/homepage/search-results page (lists multiple different shows), return:
{
  "pageType": "catalog",
  "shows": [
    {
      "title": "Anime Show Title",
      "url": "The full or relative series page URL on the website (e.g., /series/blue-box-sub)",
      "coverImage": "The poster or image URL of this show",
      "description": "Short snippet (e.g., 'Completed', '12 Episodes', 'Ongoing')"
    }
  ]
}

Guidelines for Episode/Show Extraction:
- If pageType is "single", look for links containing "watch", "episode", "ep-", "/tv/", "/movie/", or list of episodes/chapters.
- Ensure all relative URLs (for episodes or shows) are absolute, using the base origin of "${new URL(normalizedUrl).origin}" if needed.
- Sort the episodes in ascending order by episodeNumber.
- Return ONLY the structured JSON object. Do not wrap in markdown \`\`\`json blocks. Do not add any extra text or explanations.`;

      const genRes = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const resultText = genRes.text.trim();
      let parsedData: any = {};
      try {
        parsedData = JSON.parse(resultText);
      } catch (jsonErr) {
        // If it was wrapped in a codeblock, unwrap it
        const cleanedText = resultText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
        parsedData = JSON.parse(cleanedText);
      }

      return res.json({ success: true, data: parsedData });
    } catch (err: any) {
      console.error('[Universal Scraper Error]:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to scrape or parse the web page' });
    }
  });

  // Lazy initialize Google GenAI SDK to handle missing key safely
  let aiInstance: any = null;
  function getAI() {
    if (!aiInstance) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.warn('[Gemini] GEMINI_API_KEY environment variable is not defined.');
      }
      aiInstance = new GoogleGenAI({
        apiKey: apiKey || 'MOCK_KEY',
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
    return aiInstance;
  }

  // Fetch YouTube video details safely using Invidious/scraping
  async function getYouTubeVideoDetails(url: string) {
    try {
      let videoId = '';
      const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
      if (match && match[1]) {
        videoId = match[1];
      }
      if (!videoId) return null;

      // Try open Invidious API first
      const response = await fetch(`https://inv.nadeko.net/api/v1/videos/${videoId}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (response && response.ok) {
        const data = await response.json();
        return {
          title: data.title || '',
          description: data.description || '',
          id: videoId
        };
      }

      // Scraping fallback
      const htmlRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(5000)
      }).catch(() => null);

      if (htmlRes && htmlRes.ok) {
        const html = await htmlRes.text();
        const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
        const descMatch = html.match(/<meta name="description" content="([\s\S]*?)"/i);
        return {
          title: titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : '',
          description: descMatch ? descMatch[1].trim() : '',
          id: videoId
        };
      }
      return { title: '', description: '', id: videoId };
    } catch (e: any) {
      console.error('Error fetching YouTube details:', e.message);
      return null;
    }
  }

  function cleanYouTubeTitle(title: string): string {
    let cleaned = title;
    // Remove suffix and parentheses content
    cleaned = cleaned.replace(/\(.*?\)/g, '');
    cleaned = cleaned.replace(/\[.*?\]/g, '');
    // Remove common trailer terms case-insensitively
    const patterns = [
      /official trailer/gi,
      /official teaser/gi,
      /teaser trailer/gi,
      /pv \d+/gi,
      /main pv/gi,
      /pv/gi,
      /trailer/gi,
      /teaser/gi,
      /anime adaptation/gi,
      /clip/gi,
      /episode \d+/gi,
      /ep \d+/gi,
      /subbed/gi,
      /dubbed/gi,
      /sub/gi,
      /dub/gi,
      /crunchyroll/gi,
      /netflix/gi,
      /ani-one/gi,
      /muse asia/gi,
    ];
    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    // Replace multiple spaces with a single space and trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // Remove trailing dashes, pipes, or colons
    cleaned = cleaned.replace(/^[\s\-:|]+|[\s\-:|]+$/g, '').trim();
    return cleaned || title.slice(0, 50);
  }

  // Automatically fetch, orchestrate, and compile anime metadata using Gemini and Jikan API
  function normalizeGenres(rawGenres: any, rawGenreField?: any): string {
    console.log(`[normalizeGenres Debug] Raw input genres:`, JSON.stringify(rawGenres), `genreField:`, JSON.stringify(rawGenreField));
    const input = rawGenres !== undefined ? rawGenres : rawGenreField;
    if (!input) return '';

    // If string
    if (typeof input === 'string') {
      return input
        .split(',')
        .map((g: any) => g.trim())
        .filter(Boolean)
        .join(', ');
    }

    // If array
    if (Array.isArray(input)) {
      const parsed = input.map((item: any) => {
        if (!item) return '';
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object') {
          return (item.name || item.genre || item.title || Object.values(item)[0] || '').toString().trim();
        }
        return String(item).trim();
      }).filter(Boolean);
      return parsed.join(', ');
    }

    // If single object
    if (typeof input === 'object') {
      const singleVal = input.name || input.genre || input.title || Object.values(input)[0];
      if (singleVal) {
        return String(singleVal).trim();
      }
    }

    return '';
  }

  app.get('/api/anime/metadata', async (req, res) => {
    const { query, refresh } = req.query;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing query parameter' });
    }

    const isForceRefresh = refresh === 'true';
    const cleanQuery = query.trim();

    try {
      const isYouTube = cleanQuery.includes('youtube.com') || cleanQuery.includes('youtu.be');
      let animeName = cleanQuery;
      let categoryHint = '';

      if (isYouTube) {
        console.log(`[Metadata Service] Query is a YouTube URL: "${cleanQuery}". Extracting video details...`);
        const ytDetails = await getYouTubeVideoDetails(cleanQuery);
        if (ytDetails && ytDetails.title) {
          console.log(`[Metadata Service] Extracted video title: "${ytDetails.title}"`);
          
          let parsedName = '';
          try {
            const ai = getAI();
            const extractionPrompt = `Analyze the following YouTube video title and description to extract the exact name/title of the anime it refers to (in English or Romaji). Also, determine what category/genres it represents.
Video Title: "${ytDetails.title}"
Video Description: "${ytDetails.description.slice(0, 500)}"

Return ONLY a JSON object with this exact structure:
{
  "animeName": "Name of the anime",
  "category": "e.g., Action, Adventure"
}
Do not include any explanation or markdown formatting outside the JSON object.`;

            const extractionRes = await ai.models.generateContent({
              model: 'gemini-3.5-flash',
              contents: extractionPrompt,
              config: {
                responseMimeType: 'application/json'
              }
            });

            const parsed = JSON.parse(extractionRes.text.trim());
            if (parsed.animeName) {
              parsedName = parsed.animeName;
              categoryHint = parsed.category || '';
              console.log(`[Metadata Service] Gemini extracted anime name: "${parsedName}" with categories: "${categoryHint}"`);
            }
          } catch (geminiExtractErr: any) {
            console.log(`[Metadata Service Info] Gemini title extraction busy or quota reached. Using regex title fallback.`);
          }

          if (parsedName) {
            animeName = parsedName;
          } else {
            animeName = cleanYouTubeTitle(ytDetails.title);
            console.log(`[Metadata Service] Regex cleaned YouTube title: "${animeName}"`);
          }
        }
      }

      // Normalize anime name for caching (lowercase, alphanumeric-only keys)
      const normalizedKey = animeName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const cacheKey = `metadata:${normalizedKey}`;
      const firebaseSafeKey = Buffer.from(cacheKey).toString('base64url');

      // 1. Check Cache first
      if (!isForceRefresh) {
        try {
          const cacheRef = ref(db, `anime_metadata_cache/${firebaseSafeKey}`);
          const snap = await get(cacheRef);
          if (snap && snap.exists()) {
            const cachedValue = snap.val();
            // Auto-heal cache: if cached value is missing or is a default placeholder, bypass cache to fetch fresh details
            const isPlaceholder = 
              !cachedValue || 
              (cachedValue.genres === 'Action, Adventure, Fantasy') ||
              (cachedValue.genres === 'Anime, Action, Adventure') ||
              (cachedValue.description && cachedValue.description.includes('Synopsis coming soon'));
            
            if (!isPlaceholder) {
              console.log(`[Metadata Cache HIT] Loaded metadata for "${animeName}" from cache`);
              cachedValue.genres = normalizeGenres(cachedValue.genres, cachedValue.genre);
              if (cachedValue.genre) {
                delete cachedValue.genre;
              }
              return res.json({ success: true, source: 'cache', data: cachedValue });
            } else {
              console.log(`[Metadata Cache BYPASS] Cached value is a placeholder for "${animeName}". Refetching...`);
            }
          }
        } catch (cacheErr: any) {
          console.warn(`[Metadata Cache Warning] Failed to read cache:`, cacheErr.message);
        }
      }

      // 2. Search and Fetch Jikan MAL details & Kitsu details in parallel
      console.log(`[Metadata Service] Searching Jikan MAL and Kitsu API for: "${animeName}"`);
      let jikanData: any = null;
      let kitsuData: any = null;

      try {
        const [jikanRes, kitsuRes] = await Promise.all([
          fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(animeName)}&limit=5`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(6000)
          }).catch(err => {
            console.warn(`[Metadata Service Warning] Jikan API fetch catch:`, err.message);
            return null;
          }),
          fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(animeName)}&include=genres&page[limit]=5`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/vnd.api+json'
            },
            signal: AbortSignal.timeout(6000)
          }).catch(err => {
            console.warn(`[Metadata Service Warning] Kitsu API fetch catch:`, err.message);
            return null;
          })
        ]);

        if (jikanRes && jikanRes.ok) {
          const json = await jikanRes.json();
          console.log(`[DEBUG API Response] Jikan raw response status: ok, count: ${json.data?.length || 0}`);
          if (json.data && json.data.length > 0) {
            jikanData = json.data;
            console.log(`[Metadata Service] Jikan MAL API found ${jikanData.length} matches`);
          }
        } else if (jikanRes) {
          console.warn(`[Metadata Service Warning] Jikan API returned non-ok status: ${jikanRes.status}`);
        }

        if (kitsuRes && kitsuRes.ok) {
          const json = await kitsuRes.json();
          console.log(`[DEBUG API Response] Kitsu raw response status: ok, count: ${json.data?.length || 0}`);
          if (json.data && json.data.length > 0) {
            const included = json.included || [];
            kitsuData = json.data.map((item: any) => {
              const attrs = item.attributes || {};
              const poster = attrs.posterImage?.large || attrs.posterImage?.original || attrs.posterImage?.medium || '';
              const cover = attrs.coverImage?.original || attrs.coverImage?.large || attrs.coverImage?.medium || attrs.coverImage?.small || '';
              
              // Extract genres for this specific item if possible
              const kitsuGenres = included
                .filter((inc: any) => inc.type === 'genres')
                .map((inc: any) => inc.attributes?.name)
                .filter(Boolean)
                .join(', ');

              return {
                title: attrs.canonicalTitle || attrs.slug || '',
                synopsis: attrs.synopsis || '',
                poster,
                cover,
                episodeCount: attrs.episodeCount || null,
                averageRating: attrs.averageRating || '',
                status: attrs.status || '',
                subtype: attrs.subtype || '',
                startDate: attrs.startDate || '',
                genres: kitsuGenres
              };
            });
            console.log(`[Metadata Service] Kitsu API found ${kitsuData.length} matches`);
          }
        } else if (kitsuRes) {
          console.warn(`[Metadata Service Warning] Kitsu API returned non-ok status: ${kitsuRes.status}`);
        }
      } catch (fetchErr: any) {
        console.warn(`[Metadata Service] Jikan/Kitsu fetching error:`, fetchErr.message);
      }

      // 3. Try to use Gemini to orchestrate, refine, and compile all 15 required metadata fields.
      // Fallback gracefully on error so that a 403 / API limit never crashes the application.
      let parsedData: any = null;
      let source = 'api';

      try {
        const ai = getAI();
        const systemPrompt = `You are a professional Anime Metadata specialist.
Given the target anime name, optional YouTube link context, and lists of search results from the Jikan MAL API and Kitsu API, compile the absolute best, most accurate, and fully structured metadata for this anime.
You MUST analyze the lists of search results to select the exact matching anime and season specified in the "Target Anime Title" (e.g., if the target is "Solo Leveling Season 2", do not pick the Season 1 results; if the target is "Saikyou Tank no Meikyuu Kouryaku: Tairyoku 9999 no I...", find the exact matching entry. If no perfect match exists in the lists, synthesize or adjust the details to perfectly fit the intended title, season, and type).
You MUST map and format everything into the exact JSON fields requested below.

Required Fields:
- title: English or Romaji name
- description: Detailed synopsis (keep it engaging, informative, and well-written)
- type: MUST be one of: "TV", "Movie", "OVA", "Special"
- status: MUST be one of: "Ongoing", "Completed", "Upcoming"
- episodes: Total number of episodes (integer)
- rating: Rating out of 10, e.g. "8.5"
- genres: List of genres, e.g. "Action, Adventure, Fantasy" (comma-separated string). Ensure these genres are accurate to the specific anime.
- studio: Production studio company (e.g. "ufotable", "MAPPA", "A-1 Pictures")
- released: Release Year (e.g., "2024")
- season: Season of release, e.g. "Spring", "Summer", "Fall", "Winter" (string)
- duration: Duration of episode or movie, e.g., "24 min per ep" (string)
- country: Country of origin, e.g., "Japan" (string)
- language: Original language, e.g., "Japanese" (string)
- poster: Best vertical poster image URL (use high-res Jikan image if available, or fetch/provide a high-quality stable image URL from Unsplash/Anilist/MyAnimeList)
- banner: Horizontal banner image URL (must be high quality, wide format, from Anilist/Unsplash/MAL)
- coverImage: High quality cover image URL (wide format, or high-res banner format)
- trailer: YouTube Embed URL or watch link (if available)

Provide the response in raw JSON format matching this schema.
Do not include any explanations, markdown packaging, or text formatting outside of the JSON object.`;

        const userPrompt = `Target Anime Title: "${animeName}"
YouTube Link Context (if any): "${isYouTube ? cleanQuery : ''}"
Category/Genre Hint: "${categoryHint}"
Jikan MAL API Search Results (up to 5 potential matches): ${jikanData ? JSON.stringify(jikanData).slice(0, 4000) : 'None'}
Kitsu API Search Results (up to 5 potential matches): ${kitsuData ? JSON.stringify(kitsuData).slice(0, 4000) : 'None'}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json'
          }
        });

        parsedData = JSON.parse(response.text.trim());
        source = 'api';

        // Find the best matching Jikan/Kitsu entry from our search results to extract actual high-quality poster and banner images
        const findBestImageMatch = () => {
          const targetTitle = (parsedData?.title || animeName).toLowerCase();
          
          let bestJikan = null;
          if (Array.isArray(jikanData)) {
            bestJikan = jikanData.find(item => item.title?.toLowerCase().includes(targetTitle) || targetTitle.includes(item.title?.toLowerCase()));
            if (!bestJikan && jikanData.length > 0) {
              bestJikan = jikanData[0];
            }
          }

          let bestKitsu = null;
          if (Array.isArray(kitsuData)) {
            bestKitsu = kitsuData.find((item: any) => item.title?.toLowerCase().includes(targetTitle) || targetTitle.includes(item.title?.toLowerCase()));
            if (!bestKitsu && kitsuData.length > 0) {
              bestKitsu = kitsuData[0];
            }
          }

          return { jikan: bestJikan, kitsu: bestKitsu };
        };

        const imageMatches = findBestImageMatch();
        const bestJikanMatch = imageMatches.jikan;
        const bestKitsuMatch = imageMatches.kitsu;

        if (bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url) {
          parsedData.poster = bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url || bestJikanMatch?.images?.jpg?.image_url || parsedData.poster;
        }
        if (bestKitsuMatch?.cover) {
          parsedData.banner = bestKitsuMatch.cover;
          parsedData.coverImage = bestKitsuMatch.cover;
        } else if (bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url) {
          const fallbackImg = bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url || bestJikanMatch?.images?.jpg?.image_url || '';
          if (parsedData.banner?.includes('unsplash') || !parsedData.banner) {
            parsedData.banner = fallbackImg;
          }
          if (parsedData.coverImage?.includes('unsplash') || !parsedData.coverImage) {
            parsedData.coverImage = fallbackImg;
          }
        }

      } catch (geminiErr: any) {
        console.log(`[Metadata Service Info] Gemini API busy or quota reached. Seamlessly utilizing direct Jikan MAL & Kitsu parser with fallback heuristics.`);
        
        const jikanSingle = Array.isArray(jikanData) && jikanData.length > 0 ? jikanData[0] : null;
        const kitsuSingle = Array.isArray(kitsuData) && kitsuData.length > 0 ? kitsuData[0] : null;

        if (jikanSingle || kitsuSingle) {
          console.log(`[Metadata Service] Parsing Jikan MAL / Kitsu data directly for metadata fallback...`);
          
          // Determine status
          let status = "Upcoming";
          const resolvedStatus = (jikanSingle?.status || kitsuSingle?.status || '').toLowerCase();
          if (resolvedStatus.includes('finished') || resolvedStatus.includes('completed') || resolvedStatus.includes('aired')) {
            status = "Completed";
          } else if (resolvedStatus.includes('airing') || resolvedStatus.includes('ongoing') || resolvedStatus.includes('current')) {
            status = "Ongoing";
          }
          
          // Determine type
          let type = "TV";
          const resolvedType = (jikanSingle?.type || kitsuSingle?.subtype || '').toUpperCase();
          if (["TV", "MOVIE", "OVA", "SPECIAL"].includes(resolvedType)) {
            type = resolvedType === "MOVIE" ? "Movie" : (resolvedType === "SPECIAL" ? "Special" : resolvedType);
          }

          // Determine genres
          let combinedGenres = '';
          if (jikanSingle) {
            const genresArr = (jikanSingle.genres || []).map((g: any) => g.name);
            const themesArr = (jikanSingle.themes || []).map((t: any) => t.name);
            const demographicsArr = (jikanSingle.demographics || []).map((d: any) => d.name);
            combinedGenres = [...new Set([...genresArr, ...themesArr, ...demographicsArr])].join(', ');
          }
          if (!combinedGenres && kitsuSingle?.genres) {
            combinedGenres = kitsuSingle.genres;
          }
          if (!combinedGenres && categoryHint) {
            combinedGenres = categoryHint;
          }
          if (!combinedGenres) {
            const lowerName = animeName.toLowerCase();
            if (lowerName.includes('horror') || lowerName.includes('scary') || lowerName.includes('ghost') || lowerName.includes('dead') || lowerName.includes('dark')) {
              combinedGenres = 'Horror, Mystery, Thriller';
            } else if (lowerName.includes('romance') || lowerName.includes('love') || lowerName.includes('school')) {
              combinedGenres = 'Romance, Drama, School';
            } else if (lowerName.includes('comedy') || lowerName.includes('funny') || lowerName.includes('gag')) {
              combinedGenres = 'Comedy, Slice of Life';
            } else if (lowerName.includes('scifi') || lowerName.includes('sci-fi') || lowerName.includes('robot') || lowerName.includes('mecha')) {
              combinedGenres = 'Sci-Fi, Action, Mecha';
            } else {
              combinedGenres = 'Anime, Action, Adventure';
            }
          }

          // Determine studio
          const studioList = jikanSingle ? ((jikanSingle.studios || []).map((s: any) => s.name).join(', ') || 'Unknown') : 'Unknown';

          // Determine release year
          let released = '2025';
          if (jikanSingle?.year) {
            released = String(jikanSingle.year);
          } else if (jikanSingle?.aired?.prop?.from?.year) {
            released = String(jikanSingle.aired.prop.from.year);
          } else if (kitsuSingle?.startDate) {
            released = kitsuSingle.startDate.slice(0, 4);
          }

          const season = jikanSingle?.season ? (jikanSingle.season.charAt(0).toUpperCase() + jikanSingle.season.slice(1)) : 'Unknown';
          const duration = jikanSingle?.duration || '24 min per ep';
          
          // Determine poster, banner, coverImage
          const poster = kitsuSingle?.poster || jikanSingle?.images?.jpg?.large_image_url || jikanSingle?.images?.jpg?.image_url || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=500&auto=format&fit=crop&q=60';
          const banner = kitsuSingle?.cover || kitsuSingle?.poster || jikanSingle?.images?.jpg?.large_image_url || jikanSingle?.images?.jpg?.image_url || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=60';
          const coverImage = banner;

          // Determine trailer URL
          let trailerUrl = '';
          if (jikanSingle?.trailer?.youtube_id) {
            trailerUrl = `https://www.youtube.com/embed/${jikanSingle.trailer.youtube_id}`;
          } else if (jikanSingle?.trailer?.embed_url || jikanSingle?.trailer?.url) {
            trailerUrl = jikanSingle.trailer.embed_url || jikanSingle.trailer.url || '';
          }

          parsedData = {
            title: jikanSingle?.title_english || jikanSingle?.title || kitsuSingle?.title || animeName,
            description: jikanSingle?.synopsis || kitsuSingle?.synopsis || `Synopsis for ${animeName} is currently unavailable.`,
            type,
            status,
            episodes: jikanSingle?.episodes || kitsuSingle?.episodeCount || 12,
            rating: jikanSingle?.score ? String(jikanSingle.score) : (kitsuSingle?.averageRating ? String(Number(kitsuSingle.averageRating) / 10) : '8.0'),
            genres: combinedGenres,
            studio: studioList,
            released,
            season,
            duration,
            country: 'Japan',
            language: 'Japanese',
            poster,
            banner,
            coverImage,
            trailer: trailerUrl
          };
          source = 'jikan_fallback';
        } else {
          console.log(`[Metadata Service] No Jikan/Kitsu data available. Applying default placeholder values.`);
          const resolvedFallbackGenres = (() => {
            if (categoryHint) return categoryHint;
            const lowerName = animeName.toLowerCase();
            if (lowerName.includes('horror') || lowerName.includes('scary') || lowerName.includes('ghost') || lowerName.includes('dead') || lowerName.includes('dark')) {
              return 'Horror, Mystery, Thriller';
            } else if (lowerName.includes('romance') || lowerName.includes('love') || lowerName.includes('school')) {
              return 'Romance, Drama, School';
            } else if (lowerName.includes('comedy') || lowerName.includes('funny') || lowerName.includes('gag')) {
              return 'Comedy, Slice of Life';
            } else if (lowerName.includes('scifi') || lowerName.includes('sci-fi') || lowerName.includes('robot') || lowerName.includes('mecha')) {
              return 'Sci-Fi, Action, Mecha';
            }
            return 'Action, Adventure, Fantasy';
          })();

          parsedData = {
            title: animeName,
            description: `A spectacular anime series featuring ${animeName}. Synopsis coming soon!`,
            type: 'TV',
            status: 'Upcoming',
            episodes: 12,
            rating: '7.5',
            genres: resolvedFallbackGenres,
            studio: 'Unknown',
            released: '2025',
            season: 'Winter',
            duration: '24 min per ep',
            country: 'Japan',
            language: 'Japanese',
            poster: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=500&auto=format&fit=crop&q=60',
            banner: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=60',
            coverImage: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=60',
            trailer: ''
          };
          source = 'default_fallback';
        }
      }

      // 4. Save to cache (using the resolved metadata object)
      try {
        const cacheRef = ref(db, `anime_metadata_cache/${firebaseSafeKey}`);
        await set(cacheRef, parsedData);
        console.log(`[Metadata Service] Saved resolved metadata to cache for "${animeName}"`);
      } catch (cacheWriteErr: any) {
        console.error(`[Metadata Service Cache Write Fail]`, cacheWriteErr.message);
      }

      return res.json({
        success: true,
        source,
        data: parsedData
      });

    } catch (err: any) {
      console.error(`[Metadata Service Error]`, err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to auto-fetch metadata' });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');

    // Pre-parse the production index.html to collect script and style resources for Early Hints
    const earlyHintsLinks: string[] = [];
    try {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8');
        
        // Collect stylesheets
        const cssMatches = html.matchAll(/href="([^"]+\.css)"/g);
        for (const m of cssMatches) {
          earlyHintsLinks.push(`<${m[1]}>; rel=preload; as=style`);
        }

        // Collect scripts
        const jsMatches = html.matchAll(/src="([^"]+\.js)"/g);
        for (const m of jsMatches) {
          earlyHintsLinks.push(`<${m[1]}>; rel=preload; as=script`);
        }
        
        console.log(`[Early Hints Engine] Preloaded assets:`, earlyHintsLinks);
      }
    } catch (err: any) {
      console.warn('[Early Hints Engine] Could not parse index.html:', err.message);
    }

    // Serve static files with 1 year cache headers and Cloudflare integration
    app.use(express.static(distPath, {
      maxAge: '1y',
      immutable: true,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
        res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=31536000');
        res.setHeader('CDN-Cache-Control', 'max-age=31536000');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');
      }
    }));

    app.get('*', (req, res) => {
      // Send Early Hints / Link headers for lightning-fast Edge preloading
      if (earlyHintsLinks.length > 0) {
        res.setHeader('Link', earlyHintsLinks.join(', '));
      }
      
      // Let Cloudflare cache the index.html with stale-while-revalidate
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=3600');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Full-Stack Server] Running on http://localhost:${PORT}`);
  });
}

startServer();
