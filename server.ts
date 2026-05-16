import express from "express";
import { ElevenLabsClient } from "elevenlabs";
import dotenv from "dotenv";

dotenv.config();

let currentApiKeyIndex = 1;

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // CORS middleware
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // Lấy danh sách key (chỉ gọi 1 lần mỗi request)
  const getApiKeys = (): string[] => {
    const keys: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const key = process.env[`ELEVENLABS_API_KEY_${i}`];
      if (key && key.trim()) keys.push(key.trim());
    }
    if (keys.length === 0 && process.env.ELEVENLABS_API_KEY) {
      keys.push(process.env.ELEVENLABS_API_KEY.trim());
    }
    console.log(`[getApiKeys] Found ${keys.length} key(s)`);
    return keys;
  };

  // Helper xoay key: mỗi key gọi tối đa 1 lần
  const withKeyRotation = async (operation: (apiKey: string) => Promise<any>) => {
    const keys = getApiKeys(); // chỉ gọi 1 lần
    if (keys.length === 0) throw new Error("No ElevenLabs API keys configured.");

    let currentIndex = currentApiKeyIndex;
    if (currentIndex < 1 || currentIndex > keys.length) currentIndex = 1;

    // Thử lần lượt từng key, không retry cùng một key
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const apiKey = keys[currentIndex - 1];
      try {
        const result = await operation(apiKey);
        currentApiKeyIndex = currentIndex; // cập nhật index thành công
        return result;
      } catch (error: any) {
        const status = error.statusCode || error.status;
        const msg = (error.message || "").toLowerCase();
        const isQuotaOrAuth = status === 429 || status === 401 ||
                              msg.includes("quota") || msg.includes("limit") ||
                              msg.includes("credit") || msg.includes("unauthorized");

        if (isQuotaOrAuth) {
          console.log(`[Key rotation] Key index ${currentIndex} failed with ${status}, switching to next`);
          currentIndex = (currentIndex % keys.length) + 1;
          continue; // thử key tiếp theo
        }
        // Lỗi không liên quan đến quota/auth -> ném luôn
        throw error;
      }
    }
    throw new Error("All API keys exhausted or invalid.");
  };

  const getElevenLabsClient = (apiKey: string) => new ElevenLabsClient({ apiKey });

  // ==================== API ROUTES ====================
  app.get("/api/user/subscription", async (req, res) => {
    try {
      const sub = await withKeyRotation(async (apiKey) => {
        const client = getElevenLabsClient(apiKey);
        return await client.user.getSubscription();
      });
      res.json(sub);
    } catch (error: any) {
      if (error.statusCode === 401 || error.message?.includes("401"))
        return res.status(401).json({ error: "Invalid API keys", isAuthError: true });
      res.status(500).json({ error: error.message || "Failed to fetch subscription" });
    }
  });

  app.get("/api/history", async (req, res) => {
    try {
      const history = await withKeyRotation(async (apiKey) => {
        const client = getElevenLabsClient(apiKey);
        return await client.history.getAll();
      });
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch history" });
    }
  });

  app.get("/api/history/:id", async (req, res) => {
    try {
      const item = await withKeyRotation(async (apiKey) => {
        const response = await fetch(`https://api.elevenlabs.io/v1/history/${req.params.id}`, {
          headers: { "xi-api-key": apiKey },
        });
        if (!response.ok) {
          const err: any = new Error(await response.text());
          err.statusCode = response.status;
          throw err;
        }
        return await response.json();
      });
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch history item" });
    }
  });

  app.get("/api/history/:id/audio", async (req, res) => {
    try {
      const audio = await withKeyRotation(async (apiKey) => {
        const client = getElevenLabsClient(apiKey);
        return await client.history.getAudio(req.params.id);
      });
      res.setHeader("Content-Type", "audio/mpeg");
      if (audio && typeof audio.pipe === 'function') {
        audio.pipe(res);
      } else if (audio && typeof audio[Symbol.asyncIterator] === 'function') {
        for await (const chunk of audio) res.write(chunk);
        res.end();
      } else {
        res.send(Buffer.from(audio as any));
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch audio" });
    }
  });

  // ===== QUAN TRỌNG: Route TTS đã được sửa để không gửi response trong callback =====
  app.post("/api/tts", async (req, res) => {
    const { text, stability = 0.5 } = req.body;
    if (!text) return res.status(400).json({ error: "Text is required" });

    try {
      // Gọi withKeyRotation, nhận về buffer audio
      const audioBuffer = await withKeyRotation(async (apiKey) => {
        console.log(`[TTS] Trying key starting with ${apiKey.slice(0,5)}...`);
        const client = getElevenLabsClient(apiKey);

        // Sử dụng SDK, nhưng chú ý response có thể là stream hoặc buffer
        const response = await client.textToSpeech.convert(
          "pNInz6obpgDQGcFmaJgB",  // voice ID
          {
            text,
            model_id: "eleven_v3",
            voice_settings: { stability, similarity_boost: 0.75 },
          }
        );

        // Gom tất cả chunk thành buffer
        const chunks: Buffer[] = [];
        if (response && typeof response[Symbol.asyncIterator] === 'function') {
          for await (const chunk of response as any) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        } else if (Buffer.isBuffer(response)) {
          chunks.push(response);
        } else if (response instanceof Uint8Array) {
          chunks.push(Buffer.from(response));
        } else {
          chunks.push(Buffer.from(response as any));
        }
        return Buffer.concat(chunks);
      });

      // Gửi response thành công
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audioBuffer);
    } catch (error: any) {
      console.error(`[TTS] Final error: ${error.message}`);
      // Không retry, trả về lỗi ngay
      res.status(500).json({ error: error.message || "TTS failed" });
    }
  });

  // Các endpoint phụ
  app.get("/api/key-index", (req, res) => res.json({ index: currentApiKeyIndex }));
  app.post("/api/rotate-key", (req, res) => {
    const keys = getApiKeys();
    if (keys.length <= 1) return res.json({ index: 1, message: "Only one key" });
    let safeIndex = currentApiKeyIndex;
    if (safeIndex < 1 || safeIndex > keys.length) safeIndex = 1;
    const newIndex = (safeIndex % keys.length) + 1;
    currentApiKeyIndex = newIndex;
    res.json({ index: newIndex });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
