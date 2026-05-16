import express from "express";
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

  // Helper xoay key: mỗi key tối đa 1 lần
  const withKeyRotation = async (operation: (apiKey: string) => Promise<any>) => {
    const keys = getApiKeys(); // chỉ gọi 1 lần
    if (keys.length === 0) throw new Error("No ElevenLabs API keys configured.");

    let currentIndex = currentApiKeyIndex;
    if (currentIndex < 1 || currentIndex > keys.length) currentIndex = 1;

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
        throw error; // lỗi khác không retry
      }
    }
    throw new Error("All API keys exhausted or invalid.");
  };

  // ==================== API ROUTES ====================
  app.get("/api/user/subscription", async (req, res) => {
    try {
      const sub = await withKeyRotation(async (apiKey) => {
        const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
          headers: { "xi-api-key": apiKey }
        });
        if (!response.ok) {
          const err: any = new Error(await response.text());
          err.statusCode = response.status;
          throw err;
        }
        return response.json();
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
        const response = await fetch("https://api.elevenlabs.io/v1/history", {
          headers: { "xi-api-key": apiKey }
        });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
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
        return response.json();
      });
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch history item" });
    }
  });

  app.get("/api/history/:id/audio", async (req, res) => {
    try {
      const audioBuffer = await withKeyRotation(async (apiKey) => {
        const response = await fetch(`https://api.elevenlabs.io/v1/history/${req.params.id}/audio`, {
          headers: { "xi-api-key": apiKey }
        });
        if (!response.ok) throw new Error(await response.text());
        return Buffer.from(await response.arrayBuffer());
      });
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audioBuffer);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch audio" });
    }
  });

  // ==================== QUAN TRỌNG: /api/tts dùng fetch ====================
  app.post("/api/tts", async (req, res) => {
    const { text, stability = 0.5 } = req.body;
    if (!text) return res.status(400).json({ error: "Text is required" });

    try {
      const audioBuffer = await withKeyRotation(async (apiKey) => {
        console.log(`[TTS] Trying key starting with ${apiKey.slice(0,5)}...`);
        
        const requestBody = JSON.stringify({
          text,
          model_id: "eleven_v3",            // thử đổi thành "eleven_monolingual_v1" nếu free
          voice_settings: {
            stability,
            similarity_boost: 0.75,
          },
        });

        const response = await fetch(
          "https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB", // voice ID
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": apiKey,
              "User-Agent": "RenderBackend/1.0",
            },
            body: requestBody,
          }
        );

        // Log chi tiết khi lỗi
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[TTS] ElevenLabs error ${response.status}: ${errorText}`);
          const err: any = new Error(errorText || `HTTP ${response.status}`);
          err.statusCode = response.status;
          throw err;
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      });

      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audioBuffer);
    } catch (error: any) {
      console.error(`[TTS] Final error: ${error.message}`);
      res.status(500).json({ error: error.message || "TTS failed" });
    }
  });

  // Backend endpoints
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
