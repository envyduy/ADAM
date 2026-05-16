import express from "express";
import path from "path";
import { ElevenLabsClient } from "elevenlabs";
import dotenv from "dotenv";

dotenv.config();

// In-memory API key index (resets on restart - acceptable for stateless backend)
let currentApiKeyIndex = 1;

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // CORS middleware - allow frontend from any origin
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Helper to get all available API keys
  const getApiKeys = () => {
    const keys: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const key = process.env[`ELEVENLABS_API_KEY_${i}`];
      if (key && key.trim()) {
        keys.push(key.trim());
      }
    }
    // Fallback to legacy key if none of the 10 slots are filled
    if (keys.length === 0 && process.env.ELEVENLABS_API_KEY) {
      keys.push(process.env.ELEVENLABS_API_KEY.trim());
    }
    console.log(`[getApiKeys] Found ${keys.length} API key(s)`);
    return keys;
  };

  // Helper to try an operation across multiple keys if needed
  const withKeyRotation = async (operation: (apiKey: string) => Promise<any>) => {
    const keys = getApiKeys();
    if (keys.length === 0) {
      throw new Error("No ElevenLabs API keys configured. Please add them in environment variables.");
    }

    let currentIndex = currentApiKeyIndex;
    // Validate index
    if (currentIndex < 1 || currentIndex > keys.length) {
      currentIndex = 1;
    }

    let attempts = 0;
    while (attempts < keys.length) {
      const apiKey = keys[currentIndex - 1];
      try {
        const result = await operation(apiKey);
        // If successful, update this index (in-memory only)
        currentApiKeyIndex = currentIndex;
        return result;
      } catch (error: any) {
        const errorMsg = error.message?.toLowerCase() || "";
        const isQuotaError =
          error.statusCode === 429 ||
          error.status === 429 ||
          errorMsg.includes("quota") ||
          errorMsg.includes("limit") ||
          errorMsg.includes("credit");

        if (isQuotaError || error.statusCode === 401 || error.status === 401) {
          // Switch to next key
          currentIndex = (currentIndex % keys.length) + 1;
          attempts++;
          continue;
        }
        // Rethrow other errors
        throw error;
      }
    }
    throw new Error("All API keys exhausted or invalid.");
  };

  const getElevenLabsClient = (apiKey: string) => {
    return new ElevenLabsClient({ apiKey });
  };

  // API Routes
  app.get("/api/user/subscription", async (req, res) => {
    try {
      const subscription = await withKeyRotation(async (apiKey) => {
        const client = getElevenLabsClient(apiKey);
        return await client.user.getSubscription();
      });
      res.json(subscription);
    } catch (error: any) {
      if (error.statusCode === 401 || error.status === 401 || (error.message && error.message.includes("401"))) {
        return res.status(401).json({ 
          error: "Invalid ElevenLabs API Keys. Please check your keys in the Settings menu.",
          isAuthError: true 
        });
      }
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
        const response = await fetch(
          `https://api.elevenlabs.io/v1/history/${req.params.id}`,
          {
            headers: {
              "xi-api-key": apiKey,
            },
          },
        );
        if (!response.ok) {
          const errorData = await response.json();
          const detail = errorData.detail?.status || errorData.message || "";
          
          const err: any = new Error(detail || "Failed to fetch history item");
          err.statusCode = response.status;
          throw err;
        }
        return await response.json();
      });
      res.json(item);
    } catch (error: any) {
      res.status(500).json({
        error: error.message || "Failed to fetch history item",
      });
    }
  });

  app.get("/api/history/:id/audio", async (req, res) => {
    try {
      // For audio retrieval, we try with rotation but we need to handle the response differently
      // because it's a stream/buffer
      const audio = await withKeyRotation(async (apiKey) => {
        const client = getElevenLabsClient(apiKey);
        return await client.history.getAudio(req.params.id);
      });
      
      res.setHeader("Content-Type", "audio/mpeg");
      if (audio && typeof (audio as any).pipe === 'function') {
        (audio as any).pipe(res);
      } else if (audio && typeof (audio as any)[Symbol.asyncIterator] === 'function') {
        for await (const chunk of audio as any) {
          res.write(chunk);
        }
        res.end();
      } else {
        res.send(Buffer.from(audio as any));
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch audio" });
    }
  });

  app.post("/api/tts", async (req, res) => {
    try {
      const { text, stability } = req.body;

      if (!text) {
        return res.status(400).json({ error: "Text is required" });
      }

      await withKeyRotation(async (apiKey) => {
        console.log(`[TTS] Calling API with text length: ${text.length}`);
        
        try {
          const client = getElevenLabsClient(apiKey);
          
          // Use SDK method instead of fetch
          const response = await client.textToSpeech.convert(
            "pNInz6obpgDQGcFmaJgB",
            {
              text,
              modelId: "eleven_v3",
              voiceSettings: {
                stability: typeof stability === "number" ? stability : 0.5,
                similarityBoost: 0.75,
              },
            }
          );

          console.log(`[TTS] Successfully generated audio`);

          res.setHeader("Content-Type", "audio/mpeg");
          
          // Handle response - convert to buffer if needed
          if (response instanceof ReadableStream) {
            const reader = response.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } finally {
              reader.releaseLock();
            }
            res.end();
          } else if (Buffer.isBuffer(response)) {
            res.send(response);
          } else if (response && typeof response === 'object') {
            // If it's an object, try to convert to buffer
            res.send(Buffer.from(response));
          } else {
            res.send(response);
          }
          return true;
        } catch (error: any) {
          const statusCode = error.statusCode || error.status;
          const detail = error.message || JSON.stringify(error);
          
          console.error(`[TTS] SDK Error - Status ${statusCode}: ${detail}`);
          
          const err: any = new Error(detail || "TTS failed");
          err.statusCode = statusCode;
          throw err;
        }
      });
    } catch (error: any) {
      console.error(`[TTS] Request error: ${error.message}`);
      res.status(500).json({ error: error.message || "Failed to generate speech" });
    }
  });

  // Backend-only API endpoints
  app.get("/api/key-index", (req, res) => {
    res.json({ index: currentApiKeyIndex });
  });

  app.post("/api/rotate-key", (req, res) => {
    try {
      const keys = getApiKeys();
      console.log(`[rotate-key] Available keys: ${keys.length}`);
      
      if (keys.length <= 1) {
        console.log("[rotate-key] Only one key available, returning index 1");
        return res.json({ index: 1, message: "Only one key available" });
      }
      
      console.log(`[rotate-key] Current index: ${currentApiKeyIndex}`);
      
      // Wrap index if it's out of bounds
      let safeIndex = currentApiKeyIndex;
      if (safeIndex > keys.length || safeIndex < 1) {
        safeIndex = 1;
      }
      
      const newIndex = (safeIndex % keys.length) + 1;
      console.log(`[rotate-key] Calculating: (${safeIndex} % ${keys.length}) + 1 = ${newIndex}`);
      
      currentApiKeyIndex = newIndex;
      console.log(`[rotate-key] Updated index to: ${newIndex}`);
      
      res.json({ index: newIndex });
    } catch (error) {
      console.error("[rotate-key] Error:", error);
      res.status(500).json({ error: "Failed to rotate key" });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
  });
}

startServer();
