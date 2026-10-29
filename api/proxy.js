/**
 * MindTrace Production Proxy — Vercel Serverless
 * All Meta AI calls go through here. No API key in frontend.
 * Env: META_API_KEY must be set in Vercel Dashboard
 */
export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.META_API_KEY;
  if (!apiKey) {
    console.error("[proxy] META_API_KEY missing in env");
    return res.status(500).json({ 
      error: "Server misconfigured: META_API_KEY not set. Add it in Vercel -> Settings -> Environment Variables" 
    });
  }

  const body = req.body || {};
  const bodySize = JSON.stringify(body).length;
  if (bodySize > 120000) {
    return res.status(413).json({ error: "Payload too large. Image may be too big. Try smaller photo." });
  }

  try {
    let metaInput = null;
    let model = body.model || process.env.META_MODEL || "muse-spark-open-1026";

    // 🚨 CRITICAL FIX: Meta API does not recognize Baseten models.
    // Force the model to muse-wonder-1.0 for the Meta endpoint.
    if (model === "muse-spark-open-1026" || model === "muse-spark") {
      model = "muse-wonder-1.0";
    }

    if (body.input && Array.isArray(body.input)) {
      metaInput = body.input;
    } else {
      let systemText = "";
      let userText = "";
      let imageUrl = null;

      if (body.messages && Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (m.role === "system") {
            systemText = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          } else if (m.role === "user") {
            if (typeof m.content === "string") {
              userText = m.content;
            } else if (Array.isArray(m.content)) {
              for (const part of m.content) {
                if (part.type === "text" && part.text) userText += (userText ? "\n" : "") + part.text;
                if (part.type === "image_url" && part.image_url?.url) imageUrl = part.image_url.url;
                if (part.type === "image_url" && typeof part.image_url === "string") imageUrl = part.image_url;
              }
            }
          }
        }
      }
      if (body.imageBase64) imageUrl = body.imageBase64;
      if (body.prompt && !userText) userText = body.prompt;

      let combined = "";
      if (systemText) combined += systemText + "\n\n";
      if (userText) combined += userText;
      else combined = "Hello";

      const contentArray = [{ type: "input_text", text: combined }];
      if (imageUrl) {
        if (typeof imageUrl === "string" && imageUrl.length > 800000) {
          return res.status(413).json({ error: "Image too large. Please use a smaller photo (<600KB)." });
        }
        contentArray.push({ type: "input_image", image_url: imageUrl });
      }
      metaInput = [{ role: "user", content: contentArray }];
    }

    const upstream = await fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: metaInput,
        reasoning: body.reasoning || { effort: "low" },
        stream: false,
      }),
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      console.error("[proxy] Upstream error:", upstream.status, JSON.stringify(data).slice(0, 800));
      return res.status(upstream.status).json({ 
        error: "AI engine temporarily unavailable. Please try again.",
        details: data?.error || data 
      });
    }

    let extracted = null;
    try {
      const msg = data.output?.find((x) => x.type === "message");
      extracted = msg?.content?.[0]?.text || msg?.content?.[0]?.input_text || null;
    } catch {}

    if (extracted) {
      return res.status(200).json({
        ...data,
        choices: [{ message: { content: extracted } }],
        _meta_text: extracted,
      });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error("[proxy] Fatal:", err);
    return res.status(500).json({ error: "Proxy failed", details: String(err.message || err) });
  }
}