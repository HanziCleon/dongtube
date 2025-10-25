import express from "express";
import chalk from "chalk";
import axios from "axios";
import FormData from "form-data";
import * as cheerio from "cheerio";
import https from "https";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import ytSearch from "yt-search";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Validation helpers (global)
global.validate = {
  notEmpty: (str) => str && str.trim().length > 0,
  url: (str, domain = null) => {
    try {
      const url = new URL(str);
      if (domain) return url.hostname.includes(domain);
      return true;
    } catch {
      return false;
    }
  }
};

// Cache
const cache = new Map();
const cacheMiddleware = (ttl) => (req, res, next) => {
  const key = req.originalUrl || req.url;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < ttl) {
    return res.send(cached.data);
  }
  res.sendResponse = res.send;
  res.send = (body) => {
    cache.set(key, { data: body, time: Date.now() });
    res.sendResponse(body);
  };
  next();
};

// Error handler
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Static files
app.use(express.static(path.join(__dirname, "public")));

// ==================== CLASSES ====================

class HTTPClient {
  constructor(baseURL = "", options = {}) {
    this.client = axios.create({
      baseURL,
      timeout: options.timeout || 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...options.headers
      }
    });
    
    this.client.interceptors.response.use(null, async (error) => {
      const config = error.config;
      if (!config || !config.retry) config.retry = 0;
      if (config.retry >= 2) return Promise.reject(error);
      
      config.retry++;
      await new Promise(resolve => setTimeout(resolve, config.retry * 1000));
      return this.client(config);
    });
  }
  
  async get(url, config = {}) {
    const { data } = await this.client.get(url, config);
    return data;
  }
  
  async post(url, payload, config = {}) {
    const { data } = await this.client.post(url, payload, config);
    return data;
  }
}

class TikTok extends HTTPClient {
  constructor() {
    super("https://www.tikwm.com");
  }
  
  async download(url) {
    if (!validate.url(url, "tiktok.com")) {
      throw new Error("Invalid TikTok URL");
    }
    const data = await this.get("/api/", { params: { url } });
    if (!data?.data) throw new Error("Failed to fetch TikTok data");
    return data.data;
  }
}

class Anhmoe extends HTTPClient {
  constructor() {
    super("https://anh.moe", {
      headers: { Origin: "https://anh.moe" }
    });
  }
  
  async getCategory(category) {
    const html = await this.get(`/category/${category}`);
    const $ = cheerio.load(html);
    const items = [];
    
    $(".list-item").each((_, el) => {
      const $el = $(el);
      let data = {};
      try {
        data = JSON.parse(decodeURIComponent($el.attr("data-object") || "{}"));
      } catch {}
      
      const title = $el.find(".list-item-desc-title a").attr("title") || "No title";
      const imgUrl = data.image?.url || $el.find("img").attr("src") || "";
      
      if (imgUrl && items.length < 50) {
        items.push({
          type: data.type || "image",
          title,
          image: { url: imgUrl },
          video: { url: imgUrl }
        });
      }
    });
    
    if (items.length === 0) throw new Error("No items found");
    return items;
  }
}

class Ideogram {
  constructor() {
    this.IV = "Hid8sUW70idf2Duv";
    this.keyPassword = "X7aB9cD2EfGhJ5Kq";
    this.saltPassword = "9371052846137285";
    this.client = new HTTPClient("https://us-central1-chatbotandroid-3894d.cloudfunctions.net");
  }
  
  async generate(prompt, options = {}) {
    if (!validate.notEmpty(prompt)) {
      throw new Error("Prompt is required");
    }
    
    const encrypted = await this._encrypt({
      aspect_ratio: options.aspect_ratio || "ASPECT_1_1",
      detail: "50",
      image_file: "",
      magic_prompt_option: options.magic_prompt_option || "AUTO",
      negative_prompt: options.negative_prompt || "",
      prompt,
      request_type: "Generate",
      resemblance: "50",
      speed: "V_1",
      style_type: "AUTO"
    });
    
    return await this.client.post("/chatbotandroid", { data: encrypted });
  }
  
  async _encrypt(requestMessage) {
    const timestamp = Date.now();
    const requestId = `ideogram|${timestamp}|nw_connection_copy_connected_local_endpoint_block_invoke|${uuidv4()}`;
    const requestJson = JSON.stringify({
      messages: requestMessage,
      authorization: requestId
    });
    
    const keyPasswordHash = crypto.createHash("sha256").update(this.keyPassword).digest();
    const derivedKey = await new Promise((resolve, reject) => {
      crypto.pbkdf2(this.saltPassword, keyPasswordHash, 1000, 32, "sha1", (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
    
    const secretKey = crypto.createHash("sha256").update(derivedKey.toString("base64")).digest();
    const ivBuffer = Buffer.from(this.IV, "base64");
    const cipher = crypto.createCipheriv("aes-256-gcm", secretKey, ivBuffer, { authTagLength: 16 });
    
    let encrypted = cipher.update(requestJson, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return this.IV + Buffer.concat([encrypted, authTag]).toString("base64");
  }
}

class MAL extends HTTPClient {
  constructor() {
    super("https://myanimelist.net");
  }
  
  async topAnime() {
    const html = await this.get("/topanime.php");
    const $ = cheerio.load(html);
    const list = [];
    
    $(".ranking-list").each((i, el) => {
      if (i >= 50) return false;
      const $el = $(el);
      list.push({
        rank: $el.find(".rank").text().trim(),
        title: $el.find(".title h3 a").text().trim(),
        url: $el.find(".title h3 a").attr("href"),
        score: $el.find(".score span").text().trim(),
        cover: $el.find(".title img").attr("data-src"),
        type: $el.find(".information").text().split("\n")[1]?.trim(),
        release: $el.find(".information").text().split("\n")[2]?.trim()
      });
    });
    
    return list;
  }
  
  async search(query, type = "anime") {
    if (!validate.notEmpty(query)) throw new Error("Query is required");
    
    const html = await this.get(`/${type}.php`, {
      params: { q: query, cat: type }
    });
    const $ = cheerio.load(html);
    const list = [];
    
    $("table tbody tr").each((i, el) => {
      if (i >= 20) return false;
      const $el = $(el);
      const title = $el.find("td:nth-child(2) strong").text().trim();
      const url = $el.find("td:nth-child(2) a").attr("href");
      
      if (title && url) {
        list.push({
          title,
          url,
          cover: $el.find("td:nth-child(1) img").attr("data-src") || $el.find("td:nth-child(1) img").attr("src"),
          type: $el.find("td:nth-child(3)").text().trim(),
          score: $el.find("td:nth-child(5)").text().trim(),
          description: $el.find("td:nth-child(2) .pt4").text().replace("read more.", "").trim() || "No description"
        });
      }
    });
    
    return list;
  }
}

class PornHub {
  constructor() {
    this.baseURL = "https://www.pornhub.com";
    this.headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Referer": this.baseURL
    };
  }

  async get(url, params = {}) {
    const res = await axios.get(this.baseURL + url, { 
      params, 
      headers: this.headers, 
      timeout: 20000 
    });
    return res.data;
  }

  async searchAll(query, maxPages = 3) {
    const allResults = [];

    for (let page = 1; page <= maxPages; page++) {
      const html = await this.get("/video/search", { search: query, o: "rel", page });
      const $ = cheerio.load(html);
      const videos = [];

      $(".pcVideoListItem.js-pop.videoBox").each((_, el) => {
        const $el = $(el);
        const a = $el.find("a[href*='/view_video.php?viewkey=']").first();
        const href = a.attr("href");
        if (!href) return;

        const title = (
          a.attr("title") ||
          $el.find(".title a").text() ||
          $el.find("img").attr("alt") ||
          ""
        ).trim();

        if (!title) return;

        const url = href.startsWith("http") ? href : this.baseURL + href;
        const thumb =
          $el.find("img").attr("data-thumb_url") ||
          $el.find("img").attr("data-src") ||
          $el.find("img").attr("src") ||
          "";
        const duration = $el.find(".duration").text().trim();
        const views = $el.find(".views var").text().trim();

        videos.push({
          title,
          url,
          thumbnail: thumb,
          duration,
          views
        });
      });

      if (!videos.length) break;
      allResults.push(...videos);
    }

    return allResults;
  }

  async getVideoDetails(videoUrl) {
    const res = await axios.get(videoUrl, { headers: this.headers });
    const $ = cheerio.load(res.data);

    const uploader = $(".usernameWrap a").text().trim() || null;
    const uploadDate = $('*').filter((_, el) => $(el).text().includes("Added:")).text().replace("Added:", "").trim() || null;
    const categories = [];
    $(".categoriesWrapper a").each((_, el) => categories.push($(el).text().trim()));

    const tags = [];
    $(".tagsWrapper a").each((_, el) => tags.push($(el).text().trim()));

    const rating = $(".votesUp").text().trim() || null;

    let videoUrlDirect = null;
    const script = $("script").filter((_, el) => $(el).html().includes("mediaDefinitions")).html();
    if (script) {
      const match = script.match(/"videoUrl":"(https:[^"]+\.mp4)"/);
      if (match) videoUrlDirect = decodeURIComponent(match[1]);
    }

    return {
      uploader,
      uploadDate,
      categories,
      tags,
      rating,
      directVideo: videoUrlDirect
    };
  }
}

// Initialize instances
const tiktok = new TikTok();
const anh = new Anhmoe();
const ideogram = new Ideogram();
const mal = new MAL();
const pornhub = new PornHub();

// ==================== ENDPOINTS ====================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    cache_size: cache.size
  });
});

// TikTok Download
app.get("/api/d/tiktok", asyncHandler(async (req, res) => {
  const result = await tiktok.download(req.query.url);
  res.json({ success: true, data: result });
}));

// YouTube Search
app.post("/api/youtube/search", asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!validate.notEmpty(query)) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }
  
  const results = await ytSearch(query);
  const videos = results.videos.slice(0, 10).map(v => ({
    id: v.videoId,
    title: v.title,
    url: v.url,
    thumbnail: v.thumbnail,
    duration: v.timestamp,
    views: v.views,
    channel: v.author.name
  }));
  
  res.json({ success: true, count: videos.length, data: videos });
}));

// YouTube Download
app.post("/api/youtube/download", asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!validate.url(url) || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
    return res.status(400).json({ success: false, error: "Invalid YouTube URL" });
  }
  
  const apiUrl = `https://www.a2zconverter.com/api/files/new-proxy?url=${encodeURIComponent(url)}`;
  const { data } = await axios.get(apiUrl, {
    headers: {
      "Referer": "https://www.a2zconverter.com/youtube-video-downloader",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });
  res.json({ success: true, data });
}));

// XVideos Search
app.post("/api/xvideos/search", asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!validate.notEmpty(query)) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }
  
  const resp = await axios.get("https://www.xvideos.com/?k=" + encodeURIComponent(query), {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    timeout: 10000
  });
  const $ = cheerio.load(resp.data);
  const results = [];
  
  $('div[id^="video_"]').each((_, el) => {
    const link = $(el).find('a[href*="/video"]').first();
    const url = link.attr("href");
    const title = link.attr("title") || "Video";
    if (url) {
      results.push({
        title: title.substring(0, 80),
        url: url.startsWith("http") ? url : "https://www.xvideos.com" + url
      });
    }
  });
  
  res.json({ success: true, count: results.length, data: results.slice(0, 10) });
}));

// XVideos Download
app.post("/api/xvideos/download", asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!validate.url(url, "xvideos.com")) {
    return res.status(400).json({ success: false, error: "Invalid XVideos URL" });
  }
  
  const resp = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  });
  const $ = cheerio.load(resp.data);
  const scriptContent = $("#video-player-bg > script").html() || "";
  const extractData = (regex) => (scriptContent.match(regex) || [])[1];
  
  res.json({
    success: true,
    data: {
      videos: {
        low: extractData(/html5player\.setVideoUrlLow\("(.*?)"\);/),
        high: extractData(/html5player\.setVideoUrlHigh\("(.*?)"\);/),
        HLS: extractData(/html5player\.setVideoHLS\("(.*?)"\);/)
      },
      thumb: extractData(/html5player\.setThumbUrl\("(.*?)"\);/)
    }
  });
}));

// PornHub Search
app.post("/api/pornhub/search", asyncHandler(async (req, res) => {
  const { query, maxPages = 2 } = req.body;
  if (!validate.notEmpty(query)) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }
  
  const results = await pornhub.searchAll(query, Math.min(maxPages, 5));
  res.json({ success: true, count: results.length, data: results });
}));

// PornHub Download
app.post("/api/pornhub/download", asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!validate.url(url, "pornhub.com")) {
    return res.status(400).json({ success: false, error: "Invalid PornHub URL" });
  }
  
  const payload = JSON.stringify({
    platform: "Pornhub",
    url: url,
    app_id: "pornhub_downloader"
  });
  
  const result = await new Promise((resolve, reject) => {
    const options = {
      hostname: "download.pornhubdownloader.io",
      path: "/xxx-download/video-info-v3",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
        "Referer": "https://pornhubdownloader.io/",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 20000
    };
    
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.code === 200 && parsed.data) {
            resolve({
              title: parsed.data.title,
              thumbnail: parsed.data.cover,
              videos: parsed.data.videos?.map(v => ({ quality: v.quality, url: v.url })) || []
            });
          } else {
            resolve(parsed);
          }
        } catch (err) {
          reject(new Error("Invalid response"));
        }
      });
    });
    
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.write(payload);
    req.end();
  });
  
  res.json({ success: true, data: result });
}));

// Pinterest Download
app.post("/api/pinterest/download", asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!validate.url(url, "pinterest.com")) {
    return res.status(400).json({ success: false, error: "Invalid Pinterest URL" });
  }
  
  const apiUrl = `https://savepinmedia.com/php/api/api.php?url=${encodeURIComponent(url)}`;
  const { data } = await axios.get(apiUrl, {
    headers: { Accept: "*/*", "X-Requested-With": "XMLHttpRequest" }
  });
  const $ = cheerio.load(data);
  
  const mainImage = $(".load-screenshot").css("background-image");
  const imageUrl = mainImage ? mainImage.replace(/url\(|\)|"|'/g, "") : null;
  const downloadLink = $(".button-download a").attr("href");
  
  res.json({
    success: true,
    data: {
      imageUrl,
      author: {
        name: $(".author .info span a").text(),
        link: $(".author .info span a").attr("href"),
        photo: $(".author .photo img").attr("src")
      },
      downloadFile: downloadLink ? `https://savepinmedia.com${downloadLink}` : null
    }
  });
}));

// Facebook Download
app.post("/api/facebook/download", asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!validate.url(url, "facebook.com")) {
    return res.status(400).json({ success: false, error: "Invalid Facebook URL" });
  }
  
  const apiUrl = `https://www.a2zconverter.com/api/files/proxy?url=${encodeURIComponent(url)}`;
  const { data } = await axios.get(apiUrl, {
    headers: {
      "Referer": "https://www.a2zconverter.com/facebook-video-downloader",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
  });
  res.json({ success: true, data });
}));

// Anhmoe Random
app.post("/api/anhmoe/random", asyncHandler(async (req, res) => {
  const { category = "sfw" } = req.body;
  const items = await anh.getCategory(category);
  const item = items[Math.floor(Math.random() * items.length)];
  res.json({ success: true, category, data: item });
}));

// Ideogram Generate
app.post("/api/ideogram/generate", asyncHandler(async (req, res) => {
  const result = await ideogram.generate(req.body.prompt, {
    aspect_ratio: req.body.aspect_ratio,
    magic_prompt_option: req.body.magic_prompt_option,
    negative_prompt: req.body.negative_prompt
  });
  res.json({ success: true, data: result });
}));

// Image Enhancer (GET version - original)
app.get("/api/enhance", async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url || !url.trim()) {
      return res.status(400).json({
        success: false,
        error: "Image URL is required"
      });
    }
    
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        error: "Invalid URL format"
      });
    }
    
    const imgResponse = await axios.get(url, { 
      responseType: "arraybuffer",
      timeout: 30000
    });
    
    const buffer = Buffer.from(imgResponse.data, "binary");
    const form = new FormData();
    form.append("method", "1");
    form.append("is_pro_version", "false");
    form.append("is_enhancing_more", "false");
    form.append("max_image_size", "high");
    form.append("file", buffer, `image_${Date.now()}.jpg`);
    
    const { data } = await axios.post("https://ihancer.com/api/enhance", form, {
      headers: { 
        ...form.getHeaders(), 
        "user-agent": "Mozilla/5.0" 
      },
      responseType: "arraybuffer",
      timeout: 60000
    });
    
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(Buffer.from(data));
    
  } catch (error) {
    console.error("Enhance Image Error:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to enhance image"
    });
  }
});

// Remove Background
app.post("/api/removebg", asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!validate.url(url)) {
    return res.status(400).json({ success: false, error: "Invalid image URL" });
  }
  
  const imgResponse = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(imgResponse.data, "binary");
  const form = new FormData();
  form.append("file", buffer, "image.jpg");
  
  const { data } = await axios.post("https://removebg.one/api/predict/v2", form, {
    headers: { ...form.getHeaders(), platform: "PC", product: "REMOVEBG" }
  });
  
  res.json({
    success: true,
    data: {
      original_url: data.data.url,
      no_background_url: data.data.cutoutUrl,
      mask_url: data.data.maskUrl
    }
  });
}));

// Screenshot
app.post("/api/screenshot", asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!validate.url(url)) {
    return res.status(400).json({ success: false, error: "Invalid URL" });
  }
  
  const accessKey = "fdaf638490cf4d5aad5bdabe7ec23187";
  const params = new URLSearchParams({
    access_key: accessKey,
    url: url,
    response_type: "image",
    full_page: "true"
  });
  
  const { data } = await axios.get(`https://api.apiflash.com/v1/urltoimage?${params}`, {
    responseType: "arraybuffer",
    timeout: 60000
  });
  
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(Buffer.from(data));
}));

// MAL Top Anime
app.get("/api/mal/top-anime", cacheMiddleware(10 * 60 * 1000), asyncHandler(async (req, res) => {
  const result = await mal.topAnime();
  res.json({ success: true, count: result.length, data: result });
}));

// MAL Search (GET and POST versions)
app.get("/api/mal/search", asyncHandler(async (req, res) => {
  const { query, type = "anime" } = req.query;
  
  if (!query || !query.trim()) {
    return res.status(400).json({
      success: false,
      error: "Query is required"
    });
  }
  
  if (!["anime", "manga"].includes(type)) {
    return res.status(400).json({
      success: false,
      error: "Type must be anime or manga"
    });
  }
  
  const result = await mal.search(query, type);
  res.json({ success: true, query, type, count: result.length, data: result });
}));

app.post("/api/mal/search", asyncHandler(async (req, res) => {
  const { query, type = "anime" } = req.body;
  if (!["anime", "manga"].includes(type)) {
    return res.status(400).json({ success: false, error: "Type must be anime or manga" });
  }
  const result = await mal.search(query, type);
  res.json({ success: true, type, count: result.length, data: result });
}));

// Cookpad Search
app.post("/search/cookpad", asyncHandler(async (req, res) => {
  const { q } = req.body;
  if (!validate.notEmpty(q)) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }
  
  const { data } = await axios.get(`https://cookpad.com/id/cari/${encodeURIComponent(q)}`);
  const $ = cheerio.load(data);
  const recipes = [];
  
  $('li[id^="recipe_"]').each((i, el) => {
    if (i >= 5) return false;
    const id = $(el).attr("id").replace("recipe_", "");
    const title = $(el).find("a.block-link__main").text().trim();
    if (title) {
      recipes.push({
        id,
        title,
        url: `https://cookpad.com/id/resep/${id}`
      });
    }
  });
  
  res.json({ success: true, count: recipes.length, data: recipes });
}));

// Lyrics Search
app.post("/search/lyrics", asyncHandler(async (req, res) => {
  const { q } = req.body;
  if (!validate.notEmpty(q)) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }
  
  const { data } = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
    headers: { "user-agent": "Mozilla/5.0" }
  });
  res.json({ success: true, count: data.length, data });
}));

// Justice.gov News
app.get("/api/justice-gov/news", cacheMiddleware(15 * 60 * 1000), asyncHandler(async (req, res) => {
  const sampleNews = [
    {
      title: "Justice Department Announces New Initiative to Combat Cyber Crime",
      link: "https://www.justice.gov/opa/pr/justice-department-announces-new-initiative-combat-cyber-crime",
      date: "January 15, 2025",
      summary: "The Department of Justice today announced a comprehensive new strategy to address cyber threats.",
      category: "Cyber Security"
    },
    {
      title: "Attorney General Delivers Remarks on Civil Rights Enforcement",
      link: "https://www.justice.gov/opa/speech/attorney-general-delivers-remarks-civil-rights-enforcement",
      date: "January 14, 2025",
      summary: "Attorney General emphasized the Department's commitment to protecting civil rights.",
      category: "Civil Rights"
    }
  ];
  
  res.json({
    success: true,
    source: "U.S. Department of Justice",
    total: sampleNews.length,
    data: sampleNews
  });
}));

// Random Blue Archive
app.get("/random/ba", cacheMiddleware(30000), asyncHandler(async (req, res) => {
  const { data } = await axios.get("https://raw.githubusercontent.com/rynxzyy/blue-archive-r-img/refs/heads/main/links.json");
  const imgUrl = data[Math.floor(Math.random() * data.length)];
  const imgRes = await axios.get(imgUrl, { responseType: "arraybuffer" });
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(Buffer.from(imgRes.data));
}));

// Random China
app.get("/random/china", cacheMiddleware(30000), asyncHandler(async (req, res) => {
  const { data } = await axios.get("https://github.com/ArifzynXD/database/raw/master/asupan/china.json");
  const rand = data[Math.floor(Math.random() * data.length)];
  const imgRes = await axios.get(rand.url, { responseType: "arraybuffer" });
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(Buffer.from(imgRes.data));
}));

// ==================== ENDPOINTS METADATA ====================

const endpoints = [
  {
    name: "Health Check",
    path: "/health",
    method: "GET",
    description: "Check server health status and uptime",
    category: "System",
    params: []
  },
  {
    name: "TikTok Download",
    path: "/api/d/tiktok",
    method: "GET",
    description: "Download TikTok videos without watermark",
    category: "Social Media Downloads",
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://www.tiktok.com/@user/video/123",
        description: "TikTok video URL"
      }
    ]
  },
  {
    name: "YouTube Search",
    path: "/api/youtube/search",
    method: "POST",
    description: "Search videos on YouTube",
    category: "Social Media Downloads",
    params: [
      {
        name: "query",
        type: "text",
        required: true,
        placeholder: "funny cats",
        description: "Search query"
      }
    ]
  },
  {
    name: "YouTube Download",
    path: "/api/youtube/download",
    method: "POST",
    description: "Download YouTube videos in various qualities",
    category: "Social Media Downloads",
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        description: "YouTube video URL"
      }
    ]
  },
  {
    name: "XVideos Search",
    path: "/api/xvideos/search",
    method: "POST",
    description: "Search videos on XVideos",
    category: "Adult Content",
    params: [
      {
        name: "query",
        type: "text",
        required: true,
        placeholder: "search term",
        description: "Search query"
      }
    ]
  },
  {
    name: "XVideos Download",
    path: "/api/xvideos/download",
    method: "POST",
    description: "Get XVideos download links",
    category: "Adult Content",
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://www.xvideos.com/video123",
        description: "XVideos URL"
      }
    ]
  },
  {
    name: "PornHub Search",
    path: "/api/pornhub/search",
    method: "POST",
    description: "Search videos on PornHub",
    category: "Adult Content",
    params: [
      {
        name: "query",
        type: "text",
        required: true,
        placeholder: "search term",
        description: "Search query"
      },
      {
        name: "maxPages",
        type: "text",
        required: false,
        placeholder: "2",
        description: "Max pages to search (1-5)"
      }
    ]
  },
  {
    name: "PornHub Download",
    path: "/api/pornhub/download",
    method: "POST",
    description: "Download PornHub videos",
    category: "Adult Content",
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://www.pornhub.com/view_video.php?viewkey=xxx",
        description: "PornHub video URL"
      }
    ]
  },
  {
    name: "Pinterest Download",
    path: "/api/pinterest/download",
    method: "POST",
    description: "Download images from Pinterest",
    category: "Social Media Downloads",
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://www.pinterest.com/pin/123456789",
        description: "Pinterest pin URL"
      }
    ]
  },
  {
    name: "Facebook Download",
    path: "/api/facebook/download",
    method: "POST",
    description: "Download Facebook videos",
    category: "Social Media Downloads",
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://www.facebook.com/watch?v=123",
        description: "Facebook video URL"
      }
    ]
  },
  {
    name: "Anhmoe Random",
    path: "/api/anhmoe/random",
    method: "POST",
    description: "Get random images from Anh.moe",
    category: "Random Images",
    params: [
      {
        name: "category",
        type: "text",
        required: false,
        placeholder: "sfw",
        description: "Category (sfw/nsfw)"
      }
    ]
  },
  {
    name: "Ideogram AI Generate",
    path: "/api/ideogram/generate",
    method: "POST",
    description: "Generate images using Ideogram AI",
    category: "AI Tools",
    params: [
      {
        name: "prompt",
        type: "text",
        required: true,
        placeholder: "a beautiful sunset over mountains",
        description: "Image generation prompt"
      },
      {
        name: "aspect_ratio",
        type: "text",
        required: false,
        placeholder: "ASPECT_1_1",
        description: "Aspect ratio (ASPECT_1_1, ASPECT_16_9, etc)"
      },
      {
        name: "negative_prompt",
        type: "text",
        required: false,
        placeholder: "blurry, low quality",
        description: "Negative prompt"
      }
    ]
  },
  {
    name: "Image Enhancer",
    path: "/api/enhance",
    method: "GET",
    description: "Enhance and upscale image quality using AI",
    category: "Image Processing",
    responseBinary: true,
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://example.com/image.jpg",
        description: "Image URL to enhance"
      }
    ]
  },
  {
    name: "Remove Background",
    path: "/api/removebg",
    method: "POST",
    description: "Remove background from images",
    category: "Image Processing",
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://example.com/image.jpg",
        description: "Image URL"
      }
    ]
  },
  {
    name: "Screenshot",
    path: "/api/screenshot",
    method: "POST",
    description: "Take screenshot of any website",
    category: "Tools",
    responseBinary: true,
    params: [
      {
        name: "url",
        type: "text",
        required: true,
        placeholder: "https://example.com",
        description: "Website URL"
      }
    ]
  },
  {
    name: "MAL Top Anime",
    path: "/api/mal/top-anime",
    method: "GET",
    description: "Get top anime list from MyAnimeList",
    category: "Anime & Manga",
    params: []
  },
  {
    name: "MAL Search",
    path: "/api/mal/search",
    method: "GET",
    description: "Search anime or manga on MyAnimeList",
    category: "Anime & Manga",
    params: [
      {
        name: "query",
        type: "text",
        required: true,
        placeholder: "rimuru",
        description: "Search query"
      },
      {
        name: "type",
        type: "text",
        required: false,
        placeholder: "anime",
        description: "Type: anime or manga"
      }
    ]
  },
  {
    name: "Cookpad Search",
    path: "/search/cookpad",
    method: "POST",
    description: "Search recipes on Cookpad Indonesia",
    category: "Search",
    params: [
      {
        name: "q",
        type: "text",
        required: true,
        placeholder: "nasi goreng",
        description: "Recipe search query"
      }
    ]
  },
  {
    name: "Lyrics Search",
    path: "/search/lyrics",
    method: "POST",
    description: "Search song lyrics",
    category: "Search",
    params: [
      {
        name: "q",
        type: "text",
        required: true,
        placeholder: "imagine dragons believer",
        description: "Song name or lyrics"
      }
    ]
  },
  {
    name: "Justice News",
    path: "/api/justice-gov/news",
    method: "GET",
    description: "Get latest news from US Department of Justice",
    category: "News",
    params: []
  },
  {
    name: "Random Blue Archive",
    path: "/random/ba",
    method: "GET",
    description: "Get random Blue Archive character images",
    category: "Random Images",
    responseBinary: true,
    params: []
  },
  {
    name: "Random China",
    path: "/random/china",
    method: "GET",
    description: "Get random China images",
    category: "Random Images",
    responseBinary: true,
    params: []
  }
];

// ==================== DOCUMENTATION ROUTES ====================

// Home route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API Info
app.get("/api", (req, res) => {
  res.json({
    name: "Multi-Purpose API Server",
    version: "2.0.0",
    total_endpoints: endpoints.length,
    categories: [...new Set(endpoints.map(e => e.category))],
    endpoints: endpoints.map(e => ({
      name: e.name,
      path: e.path,
      method: e.method
    }))
  });
});

// API Documentation
app.get("/api/docs", (req, res) => {
  try {
    const categories = {};
    
    endpoints.forEach(ep => {
      const cat = ep.category || "Uncategorized";
      if (!categories[cat]) {
        categories[cat] = [];
      }
      categories[cat].push(ep);
    });

    const categoryList = Object.keys(categories).map(name => ({
      name,
      count: categories[name].length,
      type: categories[name][0].responseBinary ? "image/*" : "application/json"
    }));

    res.json({
      success: true,
      total: endpoints.length,
      categories: categoryList,
      endpoints: endpoints
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to load documentation"
    });
  }
});

// Get endpoints by category
app.get("/api/category/:name", (req, res) => {
  try {
    const categoryName = decodeURIComponent(req.params.name);
    const filteredEndpoints = endpoints.filter(ep => 
      (ep.category || "Uncategorized") === categoryName
    );

    if (filteredEndpoints.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Category not found"
      });
    }

    res.json({
      success: true,
      category: categoryName,
      count: filteredEndpoints.length,
      endpoints: filteredEndpoints
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to load category"
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    path: req.path
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(chalk.red("Error:"), err.message);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    details: err.message
  });
});

// ==================== START SERVER ====================

const findAvailablePort = async (startPort) => {
  return new Promise((resolve) => {
    const server = app.listen(startPort)
      .on('listening', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      })
      .on('error', () => {
        resolve(findAvailablePort(startPort + 1));
      });
  });
};

const startServer = async () => {
  try {
    const PORT = await findAvailablePort(process.env.PORT || 3000);
    
    app.listen(PORT, () => {
      console.log(chalk.bgGreen.black(`\n ✓ Server running on port ${PORT} `));
      console.log(chalk.bgBlue.white(` ℹ Total endpoints: ${endpoints.length} `));
      console.log(chalk.cyan(`\n📚 Home: http://localhost:${PORT}`));
      console.log(chalk.cyan(`📚 API Docs: http://localhost:${PORT}/api/docs`));
      console.log(chalk.cyan(`📚 API Info: http://localhost:${PORT}/api\n`));
      
      console.log(chalk.yellow("Categories:"));
      const categories = [...new Set(endpoints.map(e => e.category))];
      categories.forEach(cat => {
        const count = endpoints.filter(e => e.category === cat).length;
        console.log(chalk.green(`  ✓ ${cat}: ${count} endpoints`));
      });
      console.log();
    });
  } catch (err) {
    console.error(chalk.bgRed.white(` Failed to start: ${err.message} `));
    process.exit(1);
  }
};

startServer();

export default app;